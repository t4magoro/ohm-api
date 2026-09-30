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
  charges: number; // times charged, over all lives (for the jetpack milestone)
};

/** Bandung right now. Heat drains the battery, rain drains the mood, night halves both. */
export type Weather = { tempC: number; raining: boolean; isDay: boolean };

/** Set on the admin page: how long a full bar lasts on a normal day, in hours. */
export type Settings = { chargeHours: number; moodHours: number };
export const DEFAULT_SETTINGS: Settings = { chargeHours: 20, moodHours: 12.5 };
export const HOURS_RANGE = [1, 168] as const; // one hour to one week

/** How well Ohm does, 0 to 1. Measured on every message before he learns from it. */
export type Skills = { words: number; sentences: number; context: number; expression: number };

/** What's happening around Ohm (situation.ts): weather, Bandung's part of the day, low stats, what a visitor just did. */
export type Care = "charge" | "play" | "reboot";
export type Situation = "rain" | "hot" | "pagi" | "siang" | "sore" | "malam" | "battery_low" | "mood_low" | Care;
/** What Ohm knows, for the Spellbook: its vocabulary, words per language, and the four skills. */
export type LangStat = { words: number };
export type Brain = { vocab: number; langs: { id: LangStat; en: LangStat }; skills: Skills };
/** Goals everyone works on together. Reaching one gives Ohm a new part on its sprite, for good. */
export const MILESTONES = [
  { id: "antenna", counts: "words", goal: 100, goalText: "Teach Ohm 100 words", part: "a tall antenna" },
  { id: "hat", counts: "days", goal: 7, goalText: "Keep Ohm alive for 7 days in one life", part: "a top hat" },
  { id: "jetpack", counts: "charges", goal: 1000, goalText: "Charge Ohm 1,000 times", part: "a jetpack" },
] as const;
export type MilestoneId = (typeof MILESTONES)[number]["id"];
export type Counts = (typeof MILESTONES)[number]["counts"];

/** Something Ohm said, in reply to a visitor. Visitors' own messages are never shown to others. */
export type Line = { id: number; at: number; text: string; to: string };

export type FeedEvent = {
  id: number;
  at: number;
  type: "charge" | "play" | "reboot" | "shutdown" | "taught" | "unlocked";
  name: string;
  detail: string | null; // the words for "taught", the milestone id for "unlocked"
};

export type ClientMsg =
  | { t: "hello"; id: string; name: string; lastSeen?: number } // lastSeen: your last visit, for "while you were away"
  | { t: "charge" }
  | { t: "play" }
  | { t: "reboot" }
  | { t: "say"; text: string }
  | { t: "report"; lineId: number }
  | { t: "rate"; lineId: number; pat: boolean }; // pat (true) or frown (false) at Ohm's reply to you

export type ServerMsg =
  | { t: "state"; pet: Pet; weather: Weather; brain: Brain; unlocked: MilestoneId[]; now: number }
  | { t: "online"; online: number }
  | { t: "feed"; events: FeedEvent[] }
  | { t: "event"; e: FeedEvent }
  | { t: "lines"; lines: Line[] }
  | { t: "line"; line: Line }
  | { t: "unsay"; id: number } // you deleted one of Ohm's lines on the admin page
  | { t: "away"; learned: number; shutdowns: number; said: number } // since your last visit (said: ever)
  | { t: "notice"; msg: string }
  | { t: "error"; msg: string };

/** One hourly reading for the Vitals charts. `at` is the start of the hour. */
/** One hourly reading. `skills` is null in snapshots from before brain v2: not measured, which isn't the same as 0. */
export type Snapshot = { at: number; charge: number; mood: number; vocab: number; online: number; skills: Skills | null };

/** How far a milestone is. `etaDays` is at this week's pace: null once unlocked, or with no progress. */
export type MilestoneProgress = { id: MilestoneId; value: number; done: boolean; etaDays: number | null };

/** Everything the Vitals page shows (GET /vitals). */
export type Vitals = {
  snapshots: Snapshot[]; // hourly, last 7 days, oldest first
  hours: number[]; // 24 numbers: actions and chats in each hour of the day, Bandung time, last 7 days
  growth: { day: string; words: number }[]; // words learned per day ("2026-09-29", Bandung date), oldest first
  topWords: { word: string; uses: number; said: number; by: string }[];
  links: { word: string; situation: Situation; lift: number }[]; // the strongest word → situation links (by G²), at most 12
  milestones: MilestoneProgress[];
  brain: Brain;
  now: number;
};

/** What the admin page lists. `ipHash` is a salted hash: Ohm never stores a real IP address. */
export type AdminOverview = {
  settings: Settings;
  pending: { word: string; seen: number }[];
  reports: { id: number; at: number; lineId: number; text: string; to: string | null; ipHash: string | null }[];
  words: { word: string; by: string; ipHash: string | null; at: number }[];
  blocked: { word: string }[];
  bans: { ipHash: string; at: number }[];
};

/** What the admin search box finds (GET /admin/search?q=): the word lists, only words containing `q`. */
export type AdminSearch = Pick<AdminOverview, "words" | "pending" | "blocked"> & { q: string };

export const MAX_SAY = 200; // characters in one chat message
export const BANNED = 4003; // WebSocket close code for a banned visitor

export const CARE_GAP_MS = 3_000; // one charge, play or reboot per visitor every 3 s
export const SAY_GAP_MS = 10_000; // one chat message per visitor every 10 s

// Same formula as value_now in pet.cpp. The browser uses it to animate the bars;
// the server's C++ is the source of truth.
export const valueNow = (s: Stat, now: number) =>
  Math.max(0, s.v - (s.rate * (now - s.at)) / 3_600_000);

/** 2–16 letters, numbers, spaces, - or _. Returns the tidied name, or null if it's not allowed. */
export function cleanName(name: string): string | null {
  const n = name.trim().replace(/\s+/g, " ");
  return /^[\p{L}\p{N} _-]{2,16}$/u.test(n) ? n : null;
}