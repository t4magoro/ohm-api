// Ohm's brain: a Markov chain. It counts which word follows which in what visitors type, then talks by
// repeatedly picking a likely next word. It can only say words it has learned. There are no levels: Ohm
// babbles where he has no evidence and speaks in sentences where he has. Every rule here was tested in
// ohm-app/research/brain_sim.ipynb. Word + situation links are in grounding.ts, the skills in mind.ts,
// the tables in schema.ts; which words are allowed is decided in words.ts.
import { countSighting, linkOf, relink, situationWord } from "./grounding";
import { bump, loadMind, saveMind, type Mind } from "./mind";
import type { Brain } from "./protocol";
import type { Situation } from "./situation";
import { math } from "./wasm";
import { hasBlocked, type Lexicon } from "./words";

const START = "<s>";
const END = "</s>";
const MAX_REPLY = 12; // words in one reply
const MAX_WEIGHTS = 4096; // must match pet.cpp
const SITUATION_CHANCE = 0.3; // personality: how often Ohm talks about his situation instead of your topic

type Who = { id: string; name: string; ipHash: string };
type Row = { next: string; count: number };

const exists = (sql: SqlStorage, query: string, ...params: string[]) => sql.exec(query, ...params).toArray().length > 0;

/**
 * Ohm hears a message. First it's a test: before learning anything, the skills record how much of it he
 * could have predicted. Then he learns: allowed new words join his vocabulary, unknown words wait in the
 * queue for your approval, word triples and word + situation sightings are counted. One blocked word
 * rejects everything. The visitor rule: a count only goes up when a different visitor than last time typed it.
 * Patterns count visitors by IP hash, so one person (or one Wi-Fi) can't make Ohm repeat a sentence.
 * Situation sightings count browsers, so friends on one Wi-Fi can each teach Ohm what a word goes with.
 */
export function hear(sql: SqlStorage, lexicon: Lexicon, words: string[], who: Who, now: number, on: Situation[]) {
  if (hasBlocked(sql, lexicon, words)) return { blocked: true, learned: [] as string[] };
  const mind = loadMind(sql);

  // 1. The test, on what Ohm knew before this message.
  const browser = who.id || who.ipHash; // a socket that never said hello counts as its IP
  const lastBy = new Map<string, string | null>(); // known word → the browser whose sighting last counted
  for (const w of new Set(words)) {
    const row = sql.exec<{ seen_by: string | null }>("SELECT seen_by FROM words WHERE word = ?", w).toArray()[0];
    if (row) lastBy.set(w, row.seen_by);
  }
  for (const w of words) {
    bump(mind, "words", lastBy.has(w));
    const link = lastBy.has(w) ? linkOf(sql, w) : undefined;
    if (link) bump(mind, "context", on.includes(link));
  }

  // 2. Learn words and triples.
  const learned: string[] = [];
  const sighted: string[] = [];
  const pieces: string[][] = [[]];
  for (const w of words) {
    if (lastBy.has(w)) {
      const counts = lastBy.get(w) !== browser;
      sql.exec("UPDATE words SET uses = uses + 1, seen = seen + ?, seen_by = ? WHERE word = ?", counts ? 1 : 0, browser, w);
      if (counts) sighted.push(w);
    } else if (lexicon.langsOf(w).length > 0) {
      sql.exec(
        "INSERT INTO words (word, langs, by_id, by_name, ip_hash, at, uses, seen, seen_by) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)",
        w,
        lexicon.langsOf(w).join(","),
        who.id,
        who.name,
        who.ipHash,
        now,
        browser,
      );
      learned.push(w);
      sighted.push(w);
    } else {
      sql.exec(
        "INSERT INTO pending (word, seen, first_seen) VALUES (?, 1, ?) ON CONFLICT (word) DO UPDATE SET seen = seen + 1",
        w,
        now,
      );
      pieces.push([]); // never link two words across one Ohm doesn't know
      continue;
    }
    lastBy.set(w, browser);
    pieces.at(-1)!.push(w);
  }
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    learnPatterns(sql, piece, who.ipHash);
    mind.tokens += piece.length;
    mind.ends += 1;
  }

  // 3. Grounding: in which situations each word is said.
  for (const w of sighted) countSighting(sql, mind, w, on);
  for (const w of new Set(sighted)) relink(sql, mind, w);
  saveMind(sql, mind);
  return { blocked: false, learned };
}

// "aku suka kopi" → triples (<s>,<s>)→aku, (<s>,aku)→suka, (aku,suka)→kopi, (suka,kopi)→</s>,
// and pairs aku→suka, suka→kopi, kopi→</s> for the one-word back-off.
// Each count goes up by 1, unless the same visitor raised it last time (then nothing is written).
function learnPatterns(sql: SqlStorage, words: string[], ipHash: string) {
  const t = [START, START, ...words, END];
  for (let i = 2; i < t.length; i++) {
    sql.exec(
      `INSERT INTO grams (p2, p1, next, count, last_by) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (p2, p1, next) DO UPDATE SET count = count + 1, last_by = excluded.last_by
       WHERE grams.last_by IS NOT excluded.last_by`,
      t[i - 2],
      t[i - 1],
      t[i],
      ipHash,
    );
    if (t[i - 1] === START) continue; // Ohm always starts from a word, so he never backs off to <s> alone
    sql.exec(
      `INSERT INTO pairs (p1, next, count, last_by) VALUES (?, ?, 1, ?)
       ON CONFLICT (p1, next) DO UPDATE SET count = count + 1, last_by = excluded.last_by
       WHERE pairs.last_by IS NOT excluded.last_by`,
      t[i - 1],
      t[i],
      ipHash,
    );
  }
}
/** Picks a row with probability proportional to its count. The picking itself runs in C++. */
export function pickWeighted<T extends { count: number }>(rows: T[], random: () => number): T | undefined {
  const n = Math.min(rows.length, MAX_WEIGHTS);
  // Safe to keep this view: pet.cpp never allocates, so the WebAssembly memory never grows or moves.
  new Int32Array(math.memory.buffer, math.weights_ptr(), n).set(rows.slice(0, n).map((r) => r.count));
  const i = math.pick_weighted(n, random());
  return i < 0 ? undefined : rows[i];
}

/**
 * Continues from one context, or returns undefined to back off to a shorter one (absolute discounting):
 * every count loses 1, so a pattern with count 1 (one visitor) is never followed, and the context is
 * followed with probability (total − number of rows) / total. The rest goes to the back-off.
 */
export function follow(rows: Row[], random: () => number): string | undefined {
  const n = rows.reduce((sum, r) => sum + r.count, 0);
  const kept = n - rows.length;
  if (kept <= 0 || random() >= kept / n) return undefined;
  return pickWeighted(rows.map((r) => ({ next: r.next, count: r.count - 1 })), random)?.next;
}

/** Any word Ohm knows. A random rowid reads 1 row, where ORDER BY random() would read the whole table. */
function randomWord(sql: SqlStorage, random: () => number) {
  const top = sql.exec<{ top: number | null }>("SELECT MAX(rowid) AS top FROM words").one().top ?? 0;
  // ponytail: deleted (blocked) words leave gaps, so the word after a gap is picked a bit more often
  return sql
    .exec<{ word: string }>("SELECT word FROM words WHERE rowid >= ? ORDER BY rowid LIMIT 1", Math.floor(random() * top) + 1)
    .one().word;
}

/**
 * The next word: from the last two words, else the last word, else babble. The last word has its own
 * counts (pairs), with the visitor rule. Adding up the triples instead would let through a pair that one
 * visitor typed after two different words ("aku kopi enak", "kamu kopi enak"): brain_sim.ipynb, section 10b.
 */
function nextWord(sql: SqlStorage, mind: Mind, p2: string, p1: string, random: () => number) {
  const tri = sql
    .exec<Row>(`SELECT next, count FROM grams WHERE p2 = ? AND p1 = ? ORDER BY count DESC LIMIT ${MAX_WEIGHTS}`, p2, p1)
    .toArray();
  const pair = () =>
    sql.exec<Row>(`SELECT next, count FROM pairs WHERE p1 = ? ORDER BY count DESC LIMIT ${MAX_WEIGHTS}`, p1).toArray();
  const word = follow(tri, random) ?? follow(pair(), random);  if (word) return { word, babble: false };
  // Babble: stop as often as real sentences end, otherwise say any word Ohm knows.
  const heard = mind.tokens + mind.ends;
  return { word: random() < (heard ? mind.ends / heard : 1) ? END : randomWord(sql, random), babble: true };
}

/** Ohm answers, using only words he has learned. Returns null while he knows no words at all. */
export function reply(sql: SqlStorage, heard: string[], on: Situation[], random: () => number = Math.random): string | null {
  if (!exists(sql, "SELECT 1 FROM words LIMIT 1")) return null;
  const mind = loadMind(sql);
  // The topic: the rarest word Ohm knows in the message ("kopi", not "aku").
  const marks = heard.map(() => "?").join(",");
  const topic = heard.length
    ? sql.exec<{ word: string }>(`SELECT word FROM words WHERE word IN (${marks}) ORDER BY uses LIMIT 1`, ...heard).toArray()[0]
        ?.word
    : undefined;
  // Or, sometimes, what's on his mind: the word most clearly tied to his situation right now.
  const felt = situationWord(sql, on);
  const seed = felt && (!topic || random() < SITUATION_CHANCE) ? felt : (topic ?? randomWord(sql, random));

  const words = [seed];
  let babbleOnly = true;
  let [p2, p1] = [START, seed];
  while (words.length < MAX_REPLY) {
    const { word, babble } = nextWord(sql, mind, p2, p1, random);
    babbleOnly &&= babble;
    bump(mind, "sentences", !babble); // the skill: how much of what Ohm says follows a pattern people taught him
    if (word === END) break;
    words.push(word);
    [p2, p1] = [p1, word];
  }
  for (const w of new Set(words)) sql.exec("UPDATE words SET said = said + 1 WHERE word = ?", w);
  saveMind(sql, mind);
  return babbleOnly ? `${words.join(" ")} beep` : words.join(" ");
}

/** Vocabulary size and words per language, for the Spellbook. */
export function brainStats(sql: SqlStorage): Omit<Brain, "skills"> {
  const row = sql
    .exec<{ vocab: number; id: number | null; en: number | null }>(
      "SELECT COUNT(*) AS vocab, SUM(langs LIKE '%id%') AS id, SUM(langs LIKE '%en%') AS en FROM words",
    )
    .one();
  return { vocab: row.vocab, langs: { id: { words: row.id ?? 0 }, en: { words: row.en ?? 0 } } };
}