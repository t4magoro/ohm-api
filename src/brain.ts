// Ohm's brain: a Markov chain. It counts which word follows which in what visitors type,
// then talks by repeatedly picking a likely next word. It can only say words it has learned.
// Its tables are created in schema.ts; which words are allowed is decided in words.ts.
import type { Brain } from "./protocol";
import { math } from "./wasm";
import { hasBlocked, type Lexicon } from "./words";

const START = "<s>";
const END = "</s>";
const MAX_REPLY = 12; // words in one reply
const MAX_WEIGHTS = 4096; // must match pet.cpp

type Who = { id: string; name: string; ipHash: string };
type Row = { next: string; count: number };

const exists = (sql: SqlStorage, query: string, word: string) => sql.exec(query, word).toArray().length > 0;

/**
 * Ohm hears a message. Allowed new words join its vocabulary, unknown words wait in the
 * queue for your approval, and word triples are counted. One blocked word rejects everything.
 */
export function hear(sql: SqlStorage, lexicon: Lexicon, words: string[], who: Who, now: number) {
  if (hasBlocked(sql, lexicon, words)) return { blocked: true, learned: [] as string[] };

  const learned: string[] = [];
  const pieces: string[][] = [[]];
  for (const w of words) {
    if (exists(sql, "SELECT 1 FROM words WHERE word = ?", w)) {
      sql.exec("UPDATE words SET uses = uses + 1 WHERE word = ?", w);
    } else if (lexicon.langsOf(w).length > 0) {
      sql.exec(
        "INSERT INTO words (word, langs, by_id, by_name, ip_hash, at, uses) VALUES (?, ?, ?, ?, ?, ?, 1)",
        w,
        lexicon.langsOf(w).join(","),
        who.id,
        who.name,
        who.ipHash,
        now,
      );
      learned.push(w);
    } else {
      sql.exec(
        "INSERT INTO pending (word, seen, first_seen) VALUES (?, 1, ?) ON CONFLICT (word) DO UPDATE SET seen = seen + 1",
        w,
        now,
      );
      pieces.push([]); // never link two words across one Ohm doesn't know
      continue;
    }
    pieces.at(-1)!.push(w);
  }
  for (const piece of pieces) if (piece.length > 0) learnTriples(sql, piece);
  return { blocked: false, learned };
}

// "aku suka kopi" → (<s>,<s>)→aku, (<s>,aku)→suka, (aku,suka)→kopi, (suka,kopi)→</s>, each count + 1.
function learnTriples(sql: SqlStorage, words: string[]) {
  const t = [START, START, ...words, END];
  for (let i = 2; i < t.length; i++) {
    sql.exec(
      "INSERT INTO grams (p2, p1, next, count) VALUES (?, ?, ?, 1) ON CONFLICT (p2, p1, next) DO UPDATE SET count = count + 1",
      t[i - 2],
      t[i - 1],
      t[i],
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

function nextWord(sql: SqlStorage, p2: string, p1: string, level: number, random: () => number) {
  let rows: Row[] = [];
  if (level >= 3) {
    rows = sql
      .exec<Row>(`SELECT next, count FROM grams WHERE p2 = ? AND p1 = ? ORDER BY count DESC LIMIT ${MAX_WEIGHTS}`, p2, p1)
      .toArray();
  }
  if (rows.length === 0) {
    // Back off: look at the previous word only.
    rows = sql
      .exec<Row>(
        `SELECT next, SUM(count) AS count FROM grams WHERE p1 = ? GROUP BY next ORDER BY count DESC LIMIT ${MAX_WEIGHTS}`,
        p1,
      )
      .toArray();
  }
  return pickWeighted(rows, random)?.next;
}

/** Ohm answers, using only words it has learned. Returns null while it knows no words at all. */
export function reply(sql: SqlStorage, heard: string[], random: () => number = Math.random): string | null {
  const { vocab, level } = brainStats(sql);
  if (vocab === 0) return null;

  let words: string[];
  if (level === 1) {
    // Baby talk: 1–3 random words it knows.
    const n = 1 + Math.floor(random() * 3);
    words = sql.exec<{ word: string }>("SELECT word FROM words ORDER BY random() LIMIT ?", n).toArray().map((r) => r.word);
  } else {
    // Start from the rarest word Ohm knows in the message: it's usually the topic.
    const marks = heard.map(() => "?").join(",");
    const known = heard.length
      ? sql.exec<{ word: string }>(`SELECT word FROM words WHERE word IN (${marks}) ORDER BY uses LIMIT 1`, ...heard).toArray()
      : [];
    const seed = known[0]?.word ?? sql.exec<{ word: string }>("SELECT word FROM words ORDER BY random() LIMIT 1").one().word;
    words = [seed];
    let [p2, p1] = [START, seed];
    while (words.length < MAX_REPLY) {
      const w = nextWord(sql, p2, p1, level, random);
      if (!w || w === END) break;
      words.push(w);
      [p2, p1] = [p1, w];
    }
  }
  for (const w of new Set(words)) sql.exec("UPDATE words SET said = said + 1 WHERE word = ?", w);
  return level === 1 ? `${words.join(" ")} beep` : words.join(" ");
}

/** Vocabulary size and levels, for the Spellbook. */
export function brainStats(sql: SqlStorage): Brain {
  const row = sql
    .exec<{ vocab: number; id: number | null; en: number | null }>(
      "SELECT COUNT(*) AS vocab, SUM(langs LIKE '%id%') AS id, SUM(langs LIKE '%en%') AS en FROM words",
    )
    .one();
  const lang = (words: number) => ({ words, level: math.lang_level(words) });
  return {
    vocab: row.vocab,
    level: math.brain_level(row.vocab),
    langs: { id: lang(row.id ?? 0), en: lang(row.en ?? 0) },
  };
}
