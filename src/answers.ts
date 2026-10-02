// Conversation: what people answer right after Ohm talks to them. An exchange is Ohm's line to you, then your
// next message within 2 minutes (ohm.ts keeps the line on your connection, never in the database). The cues are
// the rarest words and word pairs of his line ("kabar", "lagi apa"), the answers the rarest words you wrote that
// weren't in it. Like a situation link (grounding.ts), a link cue → answer needs Dunning's G², lift > 1 and two
// different browsers. When your message has a cue, Ohm answers from it. Tested in brain_sim.ipynb, section 18:
// in a month he went from answering 11% of common questions to 60% (35% in a quiet crowd), and 88% of his links
// were real answers.
import { g2 } from "./grounding";
import { bump, type Mind } from "./mind";

export const ANSWER_MS = 2 * 60_000; // how long your next message counts as an answer to Ohm's line
const G2_MIN = 20; // chosen on separate tuning runs (section 18): stricter than situations, so fewer wrong links
const RAREST = 3; // cues: the 3 rarest words and 3 rarest pairs of Ohm's line. Answers: your 3 rarest new words
const KEEP = 20; // whole answers kept per cue
// What a question sounds like. "gimana" is stored as "bagaimana" (words.ts).
const QWORDS = new Set(["apa", "kenapa", "mana", "siapa", "bagaimana", "kapan", "berapa"]);

/** A cue in your message and its clearest answer word. */
export type Link = { cue: string; answer: string; g2: number; lift: number };

const marks = (list: unknown[]) => list.map(() => "?").join(",");
const pairsOf = (words: string[]) => words.slice(1).map((w, i) => `${words[i]} ${w}`);

/**
 * One exchange: Ohm said `line` to this browser, and `words` is what it wrote back. Counts every cue, every answer
 * word and, with the visitor rule, every cue + answer pair, then re-checks each cue's link. Runs on what Ohm knew
 * before this message, like the skills test. Returns the cues, to keep the answer under (keepAnswer).
 */
export function learnAnswer(sql: SqlStorage, mind: Mind, line: string[], words: string[], browser: string) {
  const all = [...new Set([...line, ...words])];
  const uses = new Map(
    sql
      .exec<{ word: string; uses: number }>(`SELECT word, uses FROM words WHERE word IN (${marks(all)})`, ...all)
      .toArray()
      .map((r) => [r.word, r.uses]),
  );
  // The rarest known words, or word pairs (a pair's uses are its two words' uses added up).
  const known = (s: string) => s.split(" ").every((w) => uses.has(w));
  const usesOf = (s: string) => s.split(" ").reduce((n, w) => n + uses.get(w)!, 0);
  const rarest = (list: string[]) =>
    [...new Set(list)]
      .filter(known)
      .sort((a, b) => usesOf(a) - usesOf(b) || (a < b ? -1 : 1))
      .slice(0, RAREST);
  const cues = [...rarest(line), ...rarest(pairsOf(line))];
  const answerWords = rarest(words.filter((w) => !line.includes(w)));

  mind.exchanges += 1;
  const ready: string[] = []; // the answers Ohm had for his line's cues, before this exchange
  for (const w of answerWords) {
    sql.exec("INSERT INTO answered (word, n) VALUES (?, 1) ON CONFLICT (word) DO UPDATE SET n = n + 1", w);
  }
  for (const cue of cues) {
    for (const w of answerWords) {
      sql.exec(
        `INSERT INTO cue_words (cue, answer, n, last_by) VALUES (?, ?, 1, ?)
         ON CONFLICT (cue, answer) DO UPDATE SET n = n + 1, last_by = excluded.last_by
         WHERE cue_words.last_by IS NOT excluded.last_by`,
        cue,
        w,
        browser,
      );
    }
    const had = relinkCue(sql, mind, cue);
    if (had) ready.push(had);
  }
  // The conversation skill: when Ohm had an answer ready for a cue of his line, did you give it?
  if (ready.length > 0) bump(mind, "conversation", ready.some((a) => words.includes(a)));
  return cues;
}

/**
 * Counts one more exchange for this cue and re-checks its link. For each answer word ever given to it, a 2×2 table
 * of exchanges (this cue or not × this answer or not). The link goes to the most significant answer that the cue
 * makes *more* likely, if it passes G2_MIN and two different browsers gave it. Returns the answer it had before.
 */
function relinkCue(sql: SqlStorage, mind: Mind, cue: string) {
  const before = sql.exec<{ n: number; answer: string | null }>("SELECT n, answer FROM cues WHERE cue = ?", cue).toArray()[0];
  const n = (before?.n ?? 0) + 1;
  const all = mind.exchanges;
  let best: Omit<Link, "cue"> | undefined;
  const rows = sql.exec<{ answer: string; k: number; answered: number }>(
    "SELECT c.answer, c.n AS k, a.n AS answered FROM cue_words c JOIN answered a ON a.word = c.answer WHERE c.cue = ? ORDER BY c.answer",
    cue,
  );
  for (const { answer, k, answered } of rows.toArray()) {
    const lift = k / n / (answered / all);
    // k has the visitor rule and the totals don't, so the last cell can come out below 0: it's at least 0
    const score = g2(k, n - k, answered - k, Math.max(0, all - n - answered + k));
    if (k >= 2 && lift > 1 && score >= G2_MIN && (!best || score > best.g2)) best = { answer, g2: score, lift };
  }
  sql.exec(
    `INSERT INTO cues (cue, n, answer, g2, lift) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (cue) DO UPDATE SET n = excluded.n, answer = excluded.answer, g2 = excluded.g2, lift = excluded.lift`,
    cue,
    n,
    best?.answer ?? null,
    best?.g2 ?? null,
    best?.lift ?? null,
  );
  return before?.answer;
}

/**
 * Keeps your whole answer under each cue, with the visitor rule, for Ohm to say when a link agrees (answerTo).
 * Up to KEEP per cue: a new one pushes out the least repeated (the oldest of those).
 */
export function keepAnswer(sql: SqlStorage, cues: string[], words: string[], browser: string, now: number) {
  const text = words.join(" ");
  for (const cue of cues) {
    const row = sql
      .exec<{ n: number }>(
        `INSERT INTO answers (cue, text, n, last_by, at) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (cue, text) DO UPDATE SET n = n + 1, last_by = excluded.last_by, at = excluded.at
         WHERE answers.last_by IS NOT excluded.last_by RETURNING n`,
        cue,
        text,
        browser,
        now,
      )
      .toArray()[0];
    if (row?.n !== 1) continue; // only a new answer can take the list past KEEP
    sql.exec(
      `DELETE FROM answers WHERE cue = ? AND text NOT IN (
         SELECT text FROM answers WHERE cue = ? ORDER BY n DESC, at DESC LIMIT ${KEEP})`,
      cue,
      cue,
    );
  }
}

/**
 * The clearest answer to a cue in your message. Most specific wins: if your message has a word pair Ohm has heard
 * as a cue ("lagi apa"), only pair links count, so a one-word link ("apa → baik") can't answer a different question.
 */
export function answerTo(sql: SqlStorage, heard: string[]): Link | undefined {
  const asked = [...new Set([...heard, ...pairsOf(heard)])];
  if (asked.length === 0) return undefined;
  const rows = sql
    .exec<Link | { cue: string; answer: null }>(`SELECT cue, answer, g2, lift FROM cues WHERE cue IN (${marks(asked)})`, ...asked)
    .toArray();
  const pairs = rows.filter((r) => r.cue.includes(" "));
  const links = (pairs.length > 0 ? pairs : rows).filter((r): r is Link => r.answer !== null);
  return links.sort((a, b) => b.g2 - a.g2 || (a.cue < b.cue ? -1 : 1))[0];
}

/** The counts behind a link's lift, as they are now (`why` shows them): see Why in protocol.ts. */
export function answerCounts(sql: SqlStorage, mind: Mind, { cue, answer }: Link) {
  const n = (query: string, ...params: string[]) => sql.exec<{ n: number }>(query, ...params).toArray()[0]?.n ?? 0;
  return {
    n: n("SELECT n FROM cue_words WHERE cue = ? AND answer = ?", cue, answer),
    of: n("SELECT n FROM cues WHERE cue = ?", cue),
    all: n("SELECT n FROM answered WHERE word = ?", answer),
    total: mind.exchanges,
  };
}

/** The answer people gave most often to this link's cue, among those with its answer word: what Ohm says whole. */
export const quoteFor = (sql: SqlStorage, link: Link) =>
  sql
    .exec<{ text: string; n: number }>(
      `SELECT text, n FROM answers WHERE cue = ? AND ' ' || text || ' ' LIKE ? ORDER BY n DESC, text DESC LIMIT 1`,
      link.cue,
      `% ${link.answer} %`,
    )
    .toArray()[0];
/** Question words people used with Ohm, for asking back. Only words he knows: he can only say those. */
export function countQuestions(mind: Mind, known: string[]) {
  for (const w of new Set(known)) if (QWORDS.has(w)) mind.questions[w] = (mind.questions[w] ?? 0) + 1;
}

/** True if the message asks something: then Ohm never asks back. */
export const isQuestion = (heard: string[]) => heard.some((w) => QWORDS.has(w));