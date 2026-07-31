import { fetchTours, toursToPrompt } from "../lib/tours.mjs";
import { buildSystemInstruction, LAURA } from "../lib/personas.mjs";

export const config = { maxDuration: 60, runtime: "nodejs" };

const MODEL = "gemini-3.1-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function jsonToTextParts(entry) {
  const parts = [];
  try {
    const cand = entry?.candidates?.[0];
    if (cand?.content?.parts) {
      for (const part of cand.content.parts) {
        if (typeof part.text === "string" && part.text) parts.push(part.text);
      }
    }
  } catch {
    /* ignore malformed events */
  }
  return parts;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === "GET") {
    sendJSON(res, 200, {
      ok: true,
      service: "Atlantic Coast Tours chatbot API",
      model: MODEL,
      assistant: { id: LAURA.id, name: LAURA.name, handle: LAURA.handle, role: LAURA.role },
      dataSource: "Google Sheets (live)",
    });
    return;
  }

  if (req.method !== "POST") {
    sendJSON(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    sendJSON(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const message = String(body.message || "").trim();
  if (!message) {
    sendJSON(res, 400, { ok: false, error: "Missing 'message'" });
    return;
  }

  let history = Array.isArray(body.history) ? body.history : [];
  history = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, parts: [{ text: String(m.content).trim() }] }));

  let systemInstruction;
  try {
    const tours = await fetchTours();
    systemInstruction = { parts: [{ text: buildSystemInstruction(toursToPrompt(tours)) }] };
  } catch (err) {
    console.error("tours fetch failed:", err.message);
    systemInstruction = { parts: [{ text: buildSystemInstruction("Tour database temporarily unavailable.") }] };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    sendJSON(res, 500, { ok: false, error: "Server not configured (GEMINI_API_KEY missing)." });
    return;
  }

  const contents = [...history, { role: "user", parts: [{ text: message }] }];

  let upstream;
  try {
    upstream = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction,
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1200 },
      }),
    });
  } catch (err) {
    console.error("gemini fetch failed:", err);
    sendJSON(res, 502, { ok: false, error: "Could not reach the AI service." });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    let detail = "";
    try {
      detail = await upstream.text();
    } catch {
      /* ignore */
    }
    console.error("gemini error:", upstream.status, detail);
    sendJSON(res, 502, { ok: false, error: `AI service error (${upstream.status})` });
    return;
  }

  res.writeHead(200, { ...CORS, "Content-Type": "text/plain; charset=utf-8", "X-Accel-Buffering": "no" });

  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let entry;
        try {
          entry = JSON.parse(payload);
        } catch {
          continue;
        }
        const texts = jsonToTextParts(entry);
        if (texts.length) {
          res.write(texts.join(""));
        }
      }
    }
  } catch (err) {
    console.error("stream error:", err);
  }
  res.end();
}
