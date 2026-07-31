import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { LAURA } from "./lib/personas.mjs";
import { fetchTours, isPlausiblePrice } from "./lib/tours.mjs";

const API_BASE = (process.env.ATLANTIC_API_BASE || "https://atlantic-coast-tours-chatbot.vercel.app").replace(/\/$/, "");

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  teal: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[96m",
};

const rl = createInterface({ input, output, terminal: false });
const lineQueue = [];
const waiters = [];
let closed = false;
rl.on("line", (line) => {
  const waiter = waiters.shift();
  if (waiter) waiter(line);
  else lineQueue.push(line);
});
rl.on("close", () => {
  closed = true;
  while (waiters.length) waiters.shift()(null);
});

function readLine(prompt) {
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (prompt) output.write(prompt);
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push(resolve));
}

const agent = LAURA;

function banner() {
  console.log(`${C.bold}${C.teal}~ Atlantic Coast Tours ${C.reset}${C.dim}· Wild Atlantic Way · Galway${C.reset}`);
  console.log(`${C.dim}Gemini 3.1 Flash-Lite · live data from Google Sheets · proxied via ${API_BASE}${C.reset}`);
  console.log(`${C.dim}Commands: /tours  /reset  /help  /quit${C.reset}`);
  console.log("");
}

async function main() {
  banner();

  const history = [{ role: "assistant", content: agent.openingLine }];
  console.log(`${C.green}${agent.name}${C.reset} ${C.dim}· ${agent.role}${C.reset}`);
  console.log(`${C.green}${agent.openingLine}${C.reset}`);
  console.log(`${C.dim}──────────────────────────────────────────${C.reset}`);

  async function handleCommand(cmd, arg) {
    switch (cmd) {
      case "/help":
        console.log(`${C.dim}/tours — list live tours from the Google Sheets database`);
        console.log(`${C.dim}/reset — clear conversation history`);
        console.log(`${C.dim}/quit — exit${C.reset}`);
        return;
      case "/reset":
        history.length = 0;
        history.push({ role: "assistant", content: agent.openingLine });
        console.log(`${C.yellow}Conversation reset.${C.reset}`);
        return;
      case "/tours":
        try {
          const tours = await fetchTours();
          console.log(`${C.bold}${C.cyan}Live tours (${tours.length}) — from Google Sheets:${C.reset}`);
          for (const t of tours) {
            const price = isPlausiblePrice(t.priceEur) ? `${t.priceEur} EUR` : "price on request";
            console.log(
              `  ${C.cyan}${t.id}${C.reset} ${C.bold}${t.name}${C.reset} ${C.dim}· ${price} · ${t.durationHours}h · ${t.location}${C.reset}${
                t.specialOffer ? ` ${C.yellow}[${t.specialOffer}]${C.reset}` : ""
              }`
            );
          }
        } catch (err) {
          console.log(`${C.red}Could not load tours: ${err.message}${C.reset}`);
        }
        return;
      case "/quit":
        console.log(`${C.green}Slán! Thanks for chatting with Atlantic Coast Tours.${C.reset}`);
        rl.close();
        process.exit(0);
        return;
      default:
        console.log(`${C.yellow}Unknown command "${cmd}". Type /help for commands.${C.reset}`);
    }
  }

  async function send(message) {
    history.push({ role: "user", content: message });
    process.stdout.write(`${C.teal}${agent.name}${C.reset} ${C.dim}· · ·${C.reset} `);
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          history: history.slice(0, -1),
        }),
      });

      if (!res.ok) {
        let detail = "";
        try {
          detail = await res.text();
        } catch {
          /* ignore */
        }
        process.stdout.write(`\r`);
        console.log(`${C.red}Request failed (${res.status}). ${detail.slice(0, 200)}${C.reset}`);
        history.pop();
        return;
      }

      if (!res.body) {
        process.stdout.write(`\r`);
        console.log(`${C.red}Empty response.${C.reset}`);
        history.pop();
        return;
      }

      process.stdout.write(`\r`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let reply = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) {
          process.stdout.write(chunk);
          reply += chunk;
        }
      }
      process.stdout.write("\n");
      if (reply.trim()) {
        history.push({ role: "assistant", content: reply.trim() });
      } else {
        console.log(`${C.red}No reply received.${C.reset}`);
        history.pop();
      }
    } catch (err) {
      process.stdout.write(`\r`);
      console.log(
        `${C.red}Could not reach ${API_BASE}/api/chat (${err.message}). Is the Vercel deployment up?${C.reset}`
      );
      history.pop();
    }
  }

  for (;;) {
    const line = (await readLine(`${C.cyan}you >${C.reset} `)) ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      if (line === null) break;
      continue;
    }
    if (trimmed.startsWith("/")) {
      const [cmd, ...rest] = trimmed.split(/\s+/);
      await handleCommand(cmd, rest.join(" "));
    } else {
      await send(trimmed);
    }
    console.log(`${C.dim}──────────────────────────────────────────${C.reset}`);
  }
  if (!closed) rl.close();
  console.log(`${C.green}Bye! Slán go fóill.${C.reset}`);
}

main().catch((err) => {
  console.error(`${C.red}Fatal: ${err.message}${C.reset}`);
  process.exit(1);
});
