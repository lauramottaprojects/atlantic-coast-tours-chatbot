export const GALWAY = { lat: 53.2707, lon: -9.0568, label: "Galway" };

export const WEATHER_CODES = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Dense drizzle",
  56: "Freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Rain showers",
  82: "Violent rain showers",
  85: "Light snow showers",
  86: "Snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

const codeOf = (c) => WEATHER_CODES[c] ?? `Weather code ${c}`;
const temp = (v) => (Number.isFinite(v) ? `${Math.round(v)}°C` : "n/a");
const wind = (v) => (Number.isFinite(v) ? `${Math.round(v)} km/h` : "n/a");

export async function geocodeCity(query) {
  const q = String(query || "").trim();
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error("geocoding HTTP " + res.status);
  const json = await res.json();
  const r = json?.results?.[0];
  if (!r) return null;
  return { lat: r.latitude, lon: r.longitude, label: [r.name, r.admin1, r.country].filter(Boolean).join(", ") };
}

export async function getForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m",
    hourly: "temperature_2m,precipitation_probability,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
    timezone: "auto",
    forecast_days: "7",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error("forecast HTTP " + res.status);
  return res.json();
}

function dayLabel(iso) {
  const d = new Date(iso + "T12:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString("en-IE", { weekday: "short", day: "numeric", month: "short" });
}

export function formatForecast(json, label) {
  if (!json?.current) return "No weather data available for this location.";
  const c = json.current;
  const lines = [];
  lines.push(`Weather for ${label}:`);
  lines.push(
    `Now: ${temp(c.temperature_2m)}, ${codeOf(c.weather_code)}; feels like ${temp(c.apparent_temperature)}; humidity ${
      c.relative_humidity_2m ?? "n/a"
    }%; wind ${wind(c.wind_speed_10m)}; precipitation ${c.precipitation ?? 0} mm.`
  );
  const d = json.daily;
  if (d?.time?.length) {
    lines.push("Forecast:");
    for (let i = 0; i < d.time.length; i++) {
      const prob = d.precipitation_probability_max?.[i];
      const wmax = d.wind_speed_10m_max?.[i];
      lines.push(
        `- ${dayLabel(d.time[i])}: ${temp(d.temperature_2m_min[i])} to ${temp(d.temperature_2m_max[i])}, ${codeOf(
          d.weather_code[i]
        )}${Number.isFinite(prob) ? `, rain chance ${prob}%` : ""}${Number.isFinite(wmax) ? `, wind ${Math.round(wmax)} km/h` : ""}`
      );
    }
  }
  return lines.join("\n");
}

export async function getWeather(args = {}, userLocation = null) {
  const coordsPair = String(args.city || "").match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  let lat = Number(args.lat);
  let lon = Number(args.lon);
  let label = String(args.city || "").trim();
  let coordsOk = Number.isFinite(lat) && Number.isFinite(lon);

  if (!coordsOk && coordsPair) {
    lat = Number(coordsPair[1]);
    lon = Number(coordsPair[2]);
    coordsOk = Number.isFinite(lat) && Number.isFinite(lon);
    label = "";
  }

  if (!coordsOk) {
    if (label) {
      const geo = await geocodeCity(label);
      if (geo) {
        lat = geo.lat;
        lon = geo.lon;
        coordsOk = true;
        label = geo.label;
      } else {
        return `Could not find a location for "${label}". Please ask for a specific city or town.`;
      }
    } else if (userLocation) {
      lat = userLocation.lat;
      lon = userLocation.lon;
      coordsOk = true;
      label = "your current location";
    } else {
      lat = GALWAY.lat;
      lon = GALWAY.lon;
      coordsOk = true;
      label = GALWAY.label;
    }
  }

  if (!coordsOk) return "Invalid coordinates.";
  const forecast = await getForecast(lat, lon);
  return formatForecast(forecast, label || "this location");
}
