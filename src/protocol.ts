// Messages between the browser and the API.
// ohm/src/lib/protocol.ts is an exact copy of this file: change both together.

/** A stat's value at one moment (`at`, ms) and how fast it drains (`rate`, points per hour). */
export type Stat = { v: number; at: number; rate: number };

export type Pet = {
  status: "on" | "off";
  charge: Stat;
  mood: Stat;
  bornAt: number; // when the current life started
  offAt: number | null; // when it last shut down
  life: number; // 1 for Ohm's first life, 2 after the first reboot…
  recordMs: number; // longest life so far
};

/** Bandung right now. Heat drains the battery, rain drains the mood, night halves both. */
export type Weather = { tempC: number; raining: boolean; isDay: boolean };

/** What Ohm knows, for the Spellbook. Levels come from pet.cpp. */
export type LangStat = { words: number; level: number };
export type Brain = { vocab: number; level: number; langs: { id: LangStat; en: LangStat } };

/** Something Ohm said, in reply to a visitor. Visitors' own messages are never shown to others. */
export type Line = { id: number; at: number; text: string; to: string };

export type FeedEvent = {
  id: number;
  at: number;
  type: "charge" | "play" | "reboot" | "shutdown" | "taught";
  name: string;
  detail: string | null; // the words, for "taught"
};

export type ClientMsg =
  | { t: "hello"; id: string; name: string }
  | { t: "charge" }
  | { t: "play" }
  | { t: "reboot" }
  | { t: "say"; text: string }
  | { t: "report"; lineId: number };

export type ServerMsg =
  | { t: "state"; pet: Pet; weather: Weather; brain: Brain; now: number }
  | { t: "online"; online: number }
  | { t: "feed"; events: FeedEvent[] }
  | { t: "event"; e: FeedEvent }
  | { t: "lines"; lines: Line[] }
  | { t: "line"; line: Line }
  | { t: "notice"; msg: string }
  | { t: "error"; msg: string };

export const MAX_SAY = 200; // characters in one chat message

// Same formula as value_now in pet.cpp. The browser uses it to animate the bars;
// the server's C++ is the source of truth.
export const valueNow = (s: Stat, now: number) =>
  Math.max(0, s.v - (s.rate * (now - s.at)) / 3_600_000);

/** 2–16 letters, numbers, spaces, - or _. Returns the tidied name, or null if it's not allowed. */
export function cleanName(name: string): string | null {
  const n = name.trim().replace(/\s+/g, " ");
  return /^[\p{L}\p{N} _-]{2,16}$/u.test(n) ? n : null;
}