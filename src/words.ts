// Which words Ohm may learn by itself, which it must never learn, and how a message becomes words.

export type Lang = "id" | "en";

export type Lexicon = {
  /** The languages whose word list contains this word. Empty = Ohm may not learn it by itself. */
  langsOf(word: string): Lang[];
  isBlocked(word: string): boolean;
};

const MAX_WORDS = 20; // words read from one message

const toSet = (text: string) => new Set(text.split("\n").map((w) => w.trim()).filter(Boolean));

/** Builds a lexicon from word lists: one word per line. */
export function makeLexicon(lists: Record<Lang, string>, block: string): Lexicon {
  const sets = (Object.keys(lists) as Lang[]).map((lang) => [lang, toSet(lists[lang])] as const);
  const blocked = toSet(block);
  return {
    langsOf: (word) => sets.filter(([, set]) => set.has(word)).map(([lang]) => lang),
    isBlocked: (word) => blocked.has(word),
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
