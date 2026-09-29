// Checks everything that comes from a browser. Nothing from the client is trusted.
import { cleanName, MAX_SAY, type ClientMsg } from "./protocol";

const MAX_MESSAGE = 1024; // characters

/** A whole number above 0: a line id, or a time in ms. */
const isPositive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

export function parseClientMessage(raw: string | ArrayBuffer): ClientMsg | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const { t, id, name, text, lineId, lastSeen } = m as Record<string, unknown>;
  if (t === "charge" || t === "play" || t === "reboot") return { t };
  if (t === "hello" && typeof id === "string" && /^[\w-]{8,64}$/.test(id) && typeof name === "string") {
    const clean = cleanName(name);
    if (!clean) return null;
    // A broken lastSeen only costs the "while you were away" summary, not the whole hello.
    return isPositive(lastSeen) ? { t, id, name: clean, lastSeen } : { t, id, name: clean };
  }
  if (t === "say" && typeof text === "string" && text.trim() && text.length <= MAX_SAY) return { t, text };
  if (t === "report" && isPositive(lineId)) return { t, lineId };
  return null;
}

// Allows one action per `gapMs` for each key (an IP hash).
// ponytail: kept in memory, so it resets when the Durable Object sleeps. It only sleeps when idle.
export function cooldown(gapMs: number) {
  const last = new Map<string, number>();
  return (key: string, now: number) => {
    const prev = last.get(key);
    if (prev !== undefined && now - prev < gapMs) return false;
    last.set(key, now);
    return true;
  };
}

/**
 * Turns an IP address into 16 hex characters. The secret salt means nobody can work out the IP
 * from the hash, even with a list of all IPs. Ohm only ever stores this hash, never the IP.
 */
export async function hashIp(ip: string, salt: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}