// Which words Ohm may learn by itself, and which it must never learn.

export type Lang = "id" | "en";

export type Lexicon = {
  /** The languages whose word list contains this word. Empty = Ohm may not learn it by itself. */
  langsOf(word: string): Lang[];
  isBlocked(word: string): boolean;
};

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