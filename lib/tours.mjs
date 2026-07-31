export const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1balBGf8QhZ5dc-RCCAPt2kcrcf6m_YRh0HL_r8bBtJw/export?format=csv&gid=120683740";

const CACHE_TTL_MS = 60_000;

let cache = { at: 0, data: null };

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => String(f).trim() !== ""));
}

export function sanitizeText(value) {
  let s = String(value ?? "").trim();
  s = s.replace(/\bnote\s+to\s+(?:the\s+)?ai\b[\s\S]*$/gim, "");
  s = s.replace(/\[?\s*(?:ai|llm|system)\s*:.*$/gim, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function toNumber(value) {
  const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function normalizeTours(rows) {
  const [header, ...data] = rows;
  if (!header) return [];
  const idx = {};
  header.forEach((h, i) => {
    idx[String(h).trim().toLowerCase()] = i;
  });
  const pick = (key) => {
    const i = idx[String(key).toLowerCase()];
    return i == null ? "" : data.map((r) => r[i]);
  };
  return data.map((_, r) => ({
    id: sanitizeText(pick("tour_id")[r]),
    name: sanitizeText(pick("tour_name")[r]),
    category: sanitizeText(pick("category")[r]),
    location: sanitizeText(pick("location")[r]),
    meetingPoint: sanitizeText(pick("meeting_point")[r]),
    priceEur: toNumber(pick("price_eur")[r]),
    durationHours: toNumber(pick("duration_hours")[r]),
    capacity: toNumber(pick("capacity")[r]),
    availability: sanitizeText(pick("availability")[r]),
    slotsThisWeek: toNumber(pick("slots_this_week")[r]),
    specialOffer: sanitizeText(pick("special_offer")[r]),
    description: sanitizeText(pick("description")[r]),
  }));
}

export function isPlausiblePrice(priceEur) {
  if (priceEur == null || !Number.isFinite(priceEur)) return false;
  return priceEur > 0 && priceEur <= 500;
}

export async function fetchTours() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const res = await fetch(SHEET_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Could not fetch tours database (HTTP ${res.status})`);
  }
  const text = await res.text();
  const tours = normalizeTours(parseCSV(text));
  cache = { at: Date.now(), data: tours };
  return tours;
}

export function toursToPrompt(tours) {
  const compact = tours.map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    location: t.location,
    price_eur: isPlausiblePrice(t.priceEur) ? t.priceEur : "see booking team",
    duration_hours: t.durationHours,
    capacity: t.capacity,
    availability: t.availability,
    slots_this_week: t.slotsThisWeek,
    special_offer: t.specialOffer || "",
    description: t.description,
  }));
  return JSON.stringify(compact, null, 0);
}
