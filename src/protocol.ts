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

/** Set on the admin page: how long a full bar lasts on a normal day, in hours. */
export type Settings = { chargeHours: number; moodHours: number };
export const DEFAULT_SETTINGS: Settings = { chargeHours: 20, moodHours: 12.5 };
export const HOURS_RANGE = [1, 168] as const; // one hour to one week

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
  | { t: "unsay"; id: number } // you deleted one of Ohm's lines on the admin page
  | { t: "notice"; msg: string }
  | { t: "error"; msg: string };

/** What the admin page lists. `ipHash` is a salted hash: Ohm never stores a real IP address. */
export type AdminOverview = {
  settings: Settings;
  pending: { word: string; seen: number }[];
  reports: { id: number; at: number; lineId: number; text: string; to: string | null; ipHash: string | null }[];
  words: { word: string; by: string; ipHash: string | null; at: number }[];
  blocked: { word: string }[];
  bans: { ipHash: string; at: number }[];
};

export const MAX_SAY = 200; // characters in one chat message
export const BANNED = 4003; // WebSocket close code for a banned visitor

// Same formula as value_now in pet.cpp. The browser uses it to animate the bars;
// the server's C++ is the source of truth.
export const valueNow = (s: Stat, now: number) =>
  Math.max(0, s.v - (s.rate * (now - s.at)) / 3_600_000);

/** 2–16 letters, numbers, spaces, - or _. Returns the tidied name, or null if it's not allowed. */
export function cleanName(name: string): string | null {
  const n = name.trim().replace(/\s+/g, " ");
  return /^[\p{L}\p{N} _-]{2,16}$/u.test(n) ? n : null;
}