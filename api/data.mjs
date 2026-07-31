import { fetchTours } from "../lib/tours.mjs";

export const config = { maxDuration: 15, runtime: "nodejs" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }
  try {
    const tours = await fetchTours();
    res.writeHead(200, {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    });
    res.end(
      JSON.stringify({
        ok: true,
        source: "Google Sheets (live)",
        updatedAt: new Date().toISOString(),
        count: tours.length,
        tours,
      })
    );
  } catch (err) {
    res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}
