import type { Weather } from "./protocol";

// Bandung's current weather from Open-Meteo: free, no API key. Their license (CC BY 4.0)
// asks for credit, which is the "Weather data by Open-Meteo.com" line on the page.
const BANDUNG =
  "https://api.open-meteo.com/v1/forecast?latitude=-6.9175&longitude=107.6191&current=temperature_2m,precipitation,is_day";

/** Used until the first real reading arrives. */
export const DEFAULT_WEATHER: Weather = { tempC: 27, raining: false, isDay: true };

/** Checks Open-Meteo's answer. It comes from outside, so it isn't trusted either. */
export function parseWeather(json: unknown): Weather | null {
  const c = (json as { current?: Record<string, unknown> } | null)?.current;
  if (!c) return null;
  const { temperature_2m: temp, precipitation: rain, is_day: day } = c;
  if (typeof temp !== "number" || !Number.isFinite(temp)) return null;
  if (typeof rain !== "number" || !Number.isFinite(rain)) return null;
  if (day !== 0 && day !== 1) return null;
  return { tempC: temp, raining: rain > 0, isDay: day === 1 };
}

export async function fetchBandungWeather(): Promise<Weather> {
  const res = await fetch(BANDUNG);
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  const weather = parseWeather(await res.json());
  if (!weather) throw new Error("Open-Meteo sent something unexpected");
  return weather;
}