// Which words Ohm may learn by itself, which it must never learn, and how a message becomes words.

export type Lang = "id" | "en";

export type Lexicon = {
  /** The languages whose word list contains this word. Empty = Ohm may not learn it by itself. */
  langsOf(word: string): Lang[];
  isBlocked(word: string): boolean;
  /** One spelling per word, to store it under: "bangettt" → "banget", and "gak", "nggak" → "tidak" (see SPELLINGS). */
  normalize(words: string[]): string[];
  /** Every spelling of a word, the stored one first: "tidak" → ["tidak", "gak", "ga", …]. Just [word] for most words. */
  spellings(word: string): string[];
};

const MAX_WORDS = 20; // words read from one message

// Chat spellings of the same word. They're folded into one before Ohm learns, so "gak", "ga" and "nggak" pool their
// evidence instead of each needing two people of its own (brain_sim.ipynb, section 18: Ohm knew 5% more of what
// people typed, and the approval queue shrank by 60%). A word is stored under the spelling that ranks highest in the
// word list, which never changes; what Ohm *says* is the spelling most people use with him (brain.ts, inStyle).
// ponytail: a hand-written list of common ones; add a group when a new chat spelling keeps showing up in the queue.
const SPELLINGS = [
  ["tidak", "gak", "ga", "nggak", "ngga", "enggak", "gk", "tdk"],
  ["sudah", "udah", "udh", "dah", "sdh"],
  ["banget", "bgt", "bngt"],
  ["yang", "yg"],
  ["juga", "jg"],
  ["lagi", "lg"],
  ["sama", "sm"],
  ["aku", "aq", "ak"],
  ["kamu", "km", "kmu"],
  ["saja", "aja", "aj"],
  ["begitu", "gitu", "gt"],
  ["bagaimana", "gimana", "gmn"],
  ["makasih", "makasi", "mksh"],
  ["sekarang", "skrg", "skr"],
  ["belum", "blm", "blom"],
  ["tahu", "tau", "tw"],
  ["bisa", "bs"],
  ["nanti", "ntar", "nnti"],
  ["karena", "krn", "karna"],
  ["iya", "iyaa", "iy"],
];

const toList = (text: string) => text.split("\n").map((w) => w.trim()).filter(Boolean);

/** Stretched letters squashed: "bangettt" → "banget", "iyaaa" → "iya". */
export const squash = (word: string) => word.replace(/(.)\1{2,}/gu, "$1");

/** Builds a lexicon from word lists: one word per line, the most used first. */
export function makeLexicon(lists: Record<Lang, string>, block: string): Lexicon {
  const sets = (Object.keys(lists) as Lang[]).map((lang) => [lang, new Set(toList(lists[lang]))] as const);
  const blocked = new Set(toList(block));
  // Each spelling → the one in its group that ranks highest in the Indonesian list (unlisted ones rank last).
  const rank = new Map<string, number>();
  for (const [i, w] of toList(lists.id).entries()) if (!rank.has(w)) rank.set(w, i);
  const score = (w: string) => rank.get(w) ?? Number.MAX_SAFE_INTEGER;
  const spell = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const group of SPELLINGS) {
    const best = group.reduce((a, b) => (score(b) < score(a) ? b : a));
    for (const w of group) spell.set(w, best);
    groups.set(best, [best, ...group.filter((w) => w !== best)]);
  }
  return {
    langsOf: (word) => sets.filter(([, set]) => set.has(word)).map(([lang]) => lang),
    isBlocked: (word) => blocked.has(word),
    normalize: (words) => words.map((w) => spell.get(squash(w)) ?? squash(w)),
    spellings: (word) => groups.get(spell.get(word) ?? word) ?? [word],
  };
}

/** "Aku  SUKA kopi!!" → ["aku", "suka", "kopi"]. Keeps letters plus inner ' and - (kupu-kupu, don't). */
export const tokenize = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}'-]+/gu, " ")
    .split(" ")
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean)
    .slice(0, MAX_WORDS);

/** True if any word is on a blocklist: the built-in one or the one you edit on the admin page. */
export const hasBlocked = (sql: SqlStorage, lexicon: Lexicon, words: string[]) =>
  words.some((w) => lexicon.isBlocked(w) || sql.exec("SELECT 1 FROM blocked WHERE word = ?", w).toArray().length > 0);