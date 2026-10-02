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
export type Skills = { words: number; guessing: number; context: number; expression: number; conversation: number };

/** What's happening around Ohm (situation.ts): weather, Bandung's part of the day, low stats, what a visitor just did. */
export type Care = "charge" | "play" | "reboot";
export type Situation = "rain" | "hot" | "pagi" | "siang" | "sore" | "malam" | "battery_low" | "mood_low" | Care;
/** What Ohm knows, for the Spellbook: its vocabulary, words per language, and the five skills. */
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

/** Every count loses this much of a vote (brain.ts; brain_sim.ipynb 19a, 24): one person's words keep ¼. The site's sums use it. */
export const DISCOUNT = 0.75;
/** How often Ohm talks about his situation instead of your topic, when he has a word for both (brain.ts). */
export const SITUATION_CHANCE = 0.3;

/**
 * How Ohm chose one word of a reply. He tries the last two words ("pair"), then the last word ("word"). A rung has
 * `votes` (its counts, with the visitor rule) for `options` different next words. Each option gives up DISCOUNT of
 * a vote to "something new", so he follows with `chance` = (votes − DISCOUNT × options) / votes, when his die
 * (`roll`, 0–1) lands below it. At the last word he always follows when anyone continued it: chance 1, no roll.
 * The rung he followed made the word: it has `picked` votes, so `share` = (picked − DISCOUNT) / (votes − DISCOUNT ×
 * options), and `pickAt` (0–1) is where in its part the pick die landed. If he followed none, he babbled: he
 * stopped when `stopRoll` < `stop` = `ends` / `heard` (sentence ends among all the words and ends he heard), or
 * said a random word he knows. "</s>" = he stopped here. His dice come from crypto.getRandomValues, so showing
 * them says nothing about his next rolls. The line's text can add "zzz…" (asleep) or "beep" (all babble), so build
 * the words from `seed`, `steps` and `back`.
 */
export type WhyStep = {
  word: string;
  tried: { rung: "pair" | "word"; chance: number; followed: boolean; votes: number; options: number; roll?: number }[];
  share?: number;
  picked?: number;
  pickAt?: number;
  stop?: number;
  ends?: number;
  heard?: number;
  stopRoll?: number;
};
/**
 * How Ohm built a reply: what was on, where he started, then every word. Sent with the live line, never stored.
 * The seed is your rarest word (topic), the word tied to his situation (with that link's lift), a random word,
 * the answer word to a `cue` in your message (with that link's lift: how many times more often people answer the
 * cue with it), or a question word when he asks back. `quote`: he said a whole answer people gave to the cue,
 * `times` times (then `steps` is empty). `counts` are the numbers behind the lift, as they are now: `n` of the
 * word's `of` sightings were in the situation (or `n` of the cue's `of` exchanges were answered with the word),
 * against `all` of `total` for every word, so lift = (n / of) / (all / total). `roll`: when he had both a situation
 * word and your topic, his die for the situation (yes when it's below SITUATION_CHANCE).
 */
export type Why = {
  on: Situation[];
  seed: {
    word: string;
    from: "topic" | "situation" | "random" | "answer" | "ask";
    situation?: Situation;
    lift?: number;
    cue?: string;
    counts?: { n: number; of: number; all: number; total: number };
    roll?: number;
  };
  steps: WhyStep[];
  /**
   * Words he added before the seed afterwards (growing to the left), nearest first. The same as `steps`, mirrored:
   * the rungs are the 2 words after it and the word after it, and "<s>" = a sentence starts here, so he stopped.
   */
  back?: WhyStep[];
  /**
   * Best of 5 (when he grew left): every try he made from the same seed, in order, and for each of its word pairs
   * whether 2+ visitors typed it (`crowd`, one per pair). He said the try at `chosen`: the biggest share of crowd
   * pairs, then the most words, then the earliest. `steps` and `back` are that try's.
   */
  tries?: { words: string[]; crowd: boolean[] }[];
  chosen?: number;
  quote?: { words: string[]; times: number };
};
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
  | { t: "line"; line: Line; why?: Why } // why: absent while Ohm sulks or knows no words
  | { t: "unsay"; id: number } // you deleted one of Ohm's lines on the admin page
  | { t: "away"; learned: number; shutdowns: number; said: number } // since your last visit (said: ever)
  | { t: "notice"; msg: string }
  | { t: "error"; msg: string };

/**
 * One hourly reading for the Vitals charts. `at` is the start of the hour. `skills` is null in snapshots from before
 * brain v2, and a skill is null in snapshots from when it wasn't measured, which isn't the same as 0: `conversation`
 * before it existed, `guessing` before brain v3, and `sentences` from brain v3 on (guessing replaced it).
 */
export type Snapshot = {
  at: number;
  charge: number;
  mood: number;
  vocab: number;
  online: number;
  skills:
    | (Omit<Skills, "guessing" | "conversation"> & Record<"sentences" | "guessing" | "conversation", number | null>)
    | null;
};

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
  answers: { text: string; n: number; at: number }[]; // kept whole answers (answers.ts), newest first
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