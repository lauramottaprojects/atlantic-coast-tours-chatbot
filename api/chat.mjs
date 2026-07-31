import { fetchTours, toursToPrompt } from "../lib/tours.mjs";
import { buildSystemInstruction, LAURA } from "../lib/personas.mjs";
import { getWeather } from "../lib/weather.mjs";

export const config = { maxDuration: 60, runtime: "nodejs" };

const MODEL = "gemini-3.1-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

const WEATHER_TOOL = {
  functionDeclarations: [
    {
      name: "get_weather",
      description:
        "Get live weather and a 7-day forecast for any place (city, town, or coordinates). Call this whenever the user asks about the weather, temperature, rain, wind, fog, conditions, or a forecast.",
      parameters: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "The place name the user asked about (e.g. 'Dingle, Ireland'). Omit if the user means their current location and coordinates are provided.",
          },
          lat: { type: "number", description: "Latitude of the user's device location, when the user means 'here'." },
          lon: { type: "number", description: "Longitude of the user's device location, when the user means 'here'." },
          date: { type: "string", description: "Optional date (YYYY-MM-DD) when the user asks about weather on a specific day." },
        },
        required: [],
      },
    },
  ],
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

function requestGemini({ systemInstruction, contents, tools }) {
  return fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction,
      contents,
      tools,
      toolConfig: tools ? { functionCallingConfig: { mode: "AUTO" } } : undefined,
      generationConfig: { temperature: 0.7, maxOutputTokens: 1200 },
    }),
  });
}

async function streamAndDetectCall(upstream, onText) {
  let detected = null;
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
        const parts = entry?.candidates?.[0]?.content?.parts;
        if (!parts) continue;
        const call = parts.find((p) => p.functionCall);
        if (call) {
          detected = { functionCall: call.functionCall, thoughtSignature: call.thoughtSignature };
          return detected;
        }
        const texts = parts.filter((p) => typeof p.text === "string").map((p) => p.text);
        if (texts.length) onText(texts.join(""));
      }
    }
  } catch (err) {
    console.error("stream error:", err);
  }
  return detected;
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
      weatherSource: "Open-Meteo (live)",
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

  const loc = body.location;
  const userLocation =
    loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lon))
      ? { lat: Number(loc.lat), lon: Number(loc.lon) }
      : null;

  let history = Array.isArray(body.history) ? body.history : [];
  history = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, parts: [{ text: String(m.content).trim() }] }));

  let systemInstruction;
  try {
    const tours = await fetchTours();
    systemInstruction = { parts: [{ text: buildSystemInstruction(toursToPrompt(tours), userLocation) }] };
  } catch (err) {
    console.error("tours fetch failed:", err.message);
    systemInstruction = { parts: [{ text: buildSystemInstruction("Tour database temporarily unavailable.", userLocation) }] };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    sendJSON(res, 500, { ok: false, error: "Server not configured (GEMINI_API_KEY missing)." });
    return;
  }

  res.writeHead(200, { ...CORS, "Content-Type": "text/plain; charset=utf-8", "X-Accel-Buffering": "no" });

  let contents = [...history, { role: "user", parts: [{ text: message }] }];

  let upstream;
  try {
    upstream = await requestGemini({ systemInstruction, contents, tools: WEATHER_TOOL });
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

  let detected = await streamAndDetectCall(upstream, (text) => res.write(text));
  let functionCall = detected ? detected.functionCall : null;
  const thoughtSignature = detected ? detected.thoughtSignature : null;

  for (let pass = 0; functionCall && pass < 3; pass++) {
    let args = {};
    try {
      args = typeof functionCall.args === "string" ? JSON.parse(functionCall.args || "{}") : functionCall.args || {};
    } catch {
      args = {};
    }

    let resultText;
    try {
      resultText = await getWeather(args, userLocation);
    } catch (err) {
      console.error("weather lookup failed:", err);
      resultText = "The weather service is temporarily unavailable. Please try again in a moment.";
    }

    const echoPart = {
      functionCall: {
        name: functionCall.name,
        args: typeof functionCall.args === "string" ? functionCall.args : args,
      },
    };
    if (thoughtSignature) echoPart.thoughtSignature = thoughtSignature;

    contents = [
      ...contents,
      { role: "model", parts: [echoPart] },
      { role: "function", parts: [{ functionResponse: { name: functionCall.name, response: { result: resultText } } }] },
    ];

    try {
      upstream = await requestGemini({ systemInstruction, contents });
    } catch (err) {
      console.error("gemini follow-up fetch failed:", err);
      res.write(`\n(Weather data: ${resultText})`);
      break;
    }

    if (!upstream.ok || !upstream.body) {
      console.error("gemini follow-up error:", upstream.status);
      res.write(`\n(Weather data: ${resultText})`);
      break;
    }

    detected = await streamAndDetectCall(upstream, (text) => res.write(text));
    functionCall = detected ? detected.functionCall : null;
  }

  res.end();
}
