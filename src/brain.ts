// Ohm's brain: a Markov chain. It counts which word follows which in what visitors type, then talks by
// repeatedly picking a likely next word. It can only say words it has learned. There are no levels: Ohm
// babbles where he has no evidence and speaks in sentences where he has. Every rule here was tested in
// ohm-app/research/brain_sim.ipynb. Word + situation links are in grounding.ts, answers in answers.ts, the skills
// in mind.ts, the tables in schema.ts; which words are allowed is decided in words.ts.
import { answerTo, countQuestions, isQuestion, keepAnswer, learnAnswer, quoteFor } from "./answers";
import { countSighting, linkOf, relink, situationWord } from "./grounding";
import { kvGet } from "./kv";
import { bump, loadMind, saveMind, type Mind } from "./mind";
import type { Brain, Why, WhyStep } from "./protocol";
import type { Situation } from "./situation";
import { math } from "./wasm";
import { hasBlocked, squash, type Lexicon } from "./words";

const START = "<s>";
const END = "</s>";
const MAX_REPLY = 12; // words in one reply
const MAX_WEIGHTS = 4096; // must match pet.cpp
const D = 0.75; // the discount: every count loses ¾ (brain_sim.ipynb, 19a, checked on the test worlds in 24)
const HOUR = 3_600_000;
const SITUATION_CHANCE = 0.3; // personality: how often Ohm talks about his situation instead of your topic
const ASK_CHANCE = 0.25; // personality: how often he asks back when he has no answer for you (brain_sim.ipynb, 18)

type Who = { id: string; name: string; ipHash: string };
type Row = { next: string; count: number };

const exists = (sql: SqlStorage, query: string, ...params: string[]) => sql.exec(query, ...params).toArray().length > 0;

/**
 * Ohm hears a message, as typed. Every word is stored in one spelling ("gak" → "tidak"), and how it was spelled
 * is counted, so Ohm can talk like the people he hears (inStyle). First it's a test: before learning anything,
 * the skills record how much of it he could have predicted. If Ohm just talked to this visitor (`line`), the
 * message is also an answer to him (answers.ts). Then he learns: allowed new words join his vocabulary, unknown
 * words wait in the queue for your approval, word triples and word + situation sightings are counted. One
 * blocked word rejects everything. The visitor rule: a count only goes up when a different visitor than last
 * time typed it. Patterns count visitors by IP hash, so one person (or one Wi-Fi) repeating a sentence can't make
 * it count more. Situation sightings and answers count browsers, so friends on one Wi-Fi can each teach Ohm what
 * a word goes with, and what to answer. And a word is sighted at most once per clock hour: messages in one hour
 * all share one weather, so a teaching drill can't link its words to it (brain_sim.ipynb, section 20).
 */
export function hear(
  sql: SqlStorage,
  lexicon: Lexicon,
  typed: string[],
  who: Who,
  now: number,
  on: Situation[],
  line: string[] = [],
) {
  const words = lexicon.normalize(typed);
  if (hasBlocked(sql, lexicon, words)) return { blocked: true, learned: [] as string[] };
  const mind = loadMind(sql);

  // 1. The test, on what Ohm knew before this message.
  const browser = who.id || who.ipHash; // a socket that never said hello counts as its IP
  const hour = Math.floor(now / HOUR);
  const lastBy = new Map<string, string | null>(); // known word → the browser whose sighting last counted
  const lastHour = new Map<string, number | null>(); // known word → the clock hour of that sighting
  for (const w of new Set(words)) {
    const row = sql
      .exec<{ seen_by: string | null; last_hour: number | null }>("SELECT seen_by, last_hour FROM words WHERE word = ?", w)
      .toArray()[0];
    if (!row) continue;
    lastBy.set(w, row.seen_by);
    lastHour.set(w, row.last_hour);
  }
  for (const w of words) {
    bump(mind, "words", lastBy.has(w));
    const link = lastBy.has(w) ? linkOf(sql, w) : undefined;
    if (link) bump(mind, "context", on.includes(link));
  }
  // Guessing: before each word he knows, and each sentence end, was his best guess right? A word he doesn't know
  // breaks the sentence, as in learning (brain_sim.ipynb, section 22).
  const known: string[][] = [[]];
  for (const w of words) {
    if (lastBy.has(w)) known.at(-1)!.push(w);
    else known.push([]);
  }
  const stop = stopChance(mind);
  const vocab = (kvGet<Omit<Brain, "skills">>(sql, "brain") ?? brainStats(sql)).vocab; // the cached count: 1 row read
  for (const piece of known.filter((p) => p.length > 0)) {
    const t = [START, START, ...piece, END];
    for (let i = 2; i < t.length; i++) bump(mind, "guessing", guess(sql, t[i - 2], t[i - 1], stop, vocab) === t[i]);
  }

  // 2. Answers: what this visitor wrote right after Ohm talked to them, also on what he knew before.
  const cues = line.length > 0 ? learnAnswer(sql, mind, line, words, browser) : [];

  // 3. Learn words and triples.
  const learned: string[] = [];
  const sighted: string[] = [];
  const pieces: string[][] = [[]];
  for (const w of words) {
    if (lastBy.has(w)) {
      if (lastBy.get(w) !== browser && lastHour.get(w) !== hour) {
        sql.exec("UPDATE words SET uses = uses + 1, seen = seen + 1, seen_by = ?, last_hour = ? WHERE word = ?", browser, hour, w);
        sighted.push(w);
        lastBy.set(w, browser);
      } else {
        sql.exec("UPDATE words SET uses = uses + 1 WHERE word = ?", w);
      }
    } else if (lexicon.langsOf(w).length > 0) {
      sql.exec(
        `INSERT INTO words (word, langs, by_id, by_name, ip_hash, at, uses, seen, seen_by, last_hour)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        w,
        lexicon.langsOf(w).join(","),
        who.id,
        who.name,
        who.ipHash,
        now,
        browser,
        hour,
      );
      learned.push(w);
      sighted.push(w);
      lastBy.set(w, browser);
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
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    learnPatterns(sql, piece, who.ipHash);
    mind.tokens += piece.length;
    mind.ends += 1;
  }
  // The whole answer too, if Ohm knows every word of it now: he only ever says words he knows.
  if (cues.length > 0 && words.length > 0 && words.every((w) => lastBy.has(w))) keepAnswer(sql, cues, words, browser, now);
  countQuestions(mind, words.filter((w) => lastBy.has(w)));

  // 4. Style: how people spell the words that have several spellings, once per browser in a row (like sightings).
  for (const s of new Set(typed.map(squash))) {
    if (lexicon.spellings(s).length < 2 || mind.spellBy[s] === browser) continue;
    mind.spellings[s] = (mind.spellings[s] ?? 0) + 1;
    mind.spellBy[s] = browser;
  }

  // 5. Grounding: in which situations each word is said.
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
 * Continues from one context, or backs off to a shorter one (absolute discounting with D = ¾): every count loses
 * three quarters, so Ohm learns from anyone, like a toddler, but a pattern one visitor typed keeps a quarter vote
 * and one two visitors typed has five quarters (brain_sim.ipynb, 19a). The context is followed with probability
 * (total − ¾ rows) / total; the rest goes to the back-off. `always` follows whenever anyone continued the context
 * (19e). Counted in quarters, 4 × count − 3, so the weights stay whole numbers for the C++ pick. Also returns that
 * chance and, when Ohm followed, the word's share of the weights: the numbers the site shows in "why".
 */
export function follow(rows: Row[], random: () => number, always = false) {
  const weights = rows.map((r) => ({ next: r.next, count: 4 * r.count - 3 }));
  const kept = weights.reduce((sum, w) => sum + w.count, 0);
  const chance = kept <= 0 ? 0 : always ? 1 : kept / (kept + 3 * rows.length); // kept + 3 × rows = 4 × total
  if (kept <= 0 || (!always && random() >= chance)) return { chance, followed: false };
  const pick = pickWeighted(weights, random)!; // every weight is at least 1
  return { chance, followed: true, word: pick.next, share: pick.count / kept };
}

/**
 * Ohm's best guess for the word after (p2, p1), for the guessing skill: the most likely word in his model, the same
 * D = ¾ steps as follow() (brain_sim.ipynb, section 22). Babble spreads its share over every word he knows, so the
 * best guess is always a word someone typed here, or the end. Ties go to the first in alphabetical order.
 */
function guess(sql: SqlStorage, p2: string, p1: string, stop: number, vocab: number) {
  const tri = sql.exec<Row>("SELECT next, count FROM grams WHERE p2 = ? AND p1 = ?", p2, p1).toArray();
  const bi = sql.exec<Row>("SELECT next, count FROM pairs WHERE p1 = ?", p1).toArray();
  // A context's own share of w, plus what it passes down times the back-off's chance of w.
  const mix = (rows: Row[], w: string, below: number) => {
    if (rows.length === 0) return below;
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    const count = rows.find((r) => r.next === w)?.count ?? 0;
    return Math.max(count - D, 0) / total + ((D * rows.length) / total) * below;
  };
  const chance = (w: string) => mix(tri, w, mix(bi, w, w === END ? stop : (1 - stop) / vocab));
  const words = [...new Set([END, ...tri.map((r) => r.next), ...bi.map((r) => r.next)])].sort();
  return words.reduce((best, w) => (chance(w) > chance(best) ? w : best));
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
 * The next word, and how Ohm got it: from the last two words, else the last word, else babble. The last word
 * has its own counts (pairs), with the visitor rule, so a pair one visitor typed after different words ("aku kopi
 * enak", "kamu kopi enak") still counts once. Adding up the triples would count it twice: brain_sim.ipynb, 10b.
 * Ohm talks from evidence: he always follows a last word anyone continued, and only babbles after a word nobody
 * did (19e). The dice at the last word are for predicting people, not for talking: rolling them made him babble.
 */
function nextWord(sql: SqlStorage, mind: Mind, p2: string, p1: string, random: () => number): WhyStep {
  const rungs = [
    ["pair", `SELECT next, count FROM grams WHERE p2 = ? AND p1 = ? ORDER BY count DESC LIMIT ${MAX_WEIGHTS}`, [p2, p1]],
    ["word", `SELECT next, count FROM pairs WHERE p1 = ? ORDER BY count DESC LIMIT ${MAX_WEIGHTS}`, [p1]],
  ] as const;
  const tried: WhyStep["tried"] = [];
  for (const [rung, query, params] of rungs) {
    const { chance, followed, word, share } = follow(sql.exec<Row>(query, ...params).toArray(), random, rung === "word");
    tried.push({ rung, chance, followed });
    if (word) return { word, tried, share };
  }
  // Babble: stop as often as real sentences end, otherwise say any word Ohm knows.
  const stop = stopChance(mind);
  return { word: random() < stop ? END : randomWord(sql, random), tried, stop };
}

/** How often babble stops: as often as the sentences Ohm heard ended. */
function stopChance(mind: Mind) {
  const heard = mind.tokens + mind.ends;
  return heard ? mind.ends / heard : 1;
}

/** Where Ohm starts when he has no answer for you: your topic, his situation, or a random word. */
function startWord(sql: SqlStorage, heard: string[], on: Situation[], random: () => number): Why["seed"] {
  // The topic: the rarest word Ohm knows in the message ("kopi", not "aku").
  const marks = heard.map(() => "?").join(",");
  const topic = heard.length
    ? sql.exec<{ word: string }>(`SELECT word FROM words WHERE word IN (${marks}) ORDER BY uses LIMIT 1`, ...heard).toArray()[0]
        ?.word
    : undefined;
  // Or, sometimes, what's on his mind: the word most clearly tied to his situation right now.
  const felt = situationWord(sql, on);
  return felt && (!topic || random() < SITUATION_CHANCE)
    ? { ...felt, from: "situation" }
    : topic
      ? { word: topic, from: "topic" }
      : { word: randomWord(sql, random), from: "random" };
}

/**
 * Ohm answers, using only words he has learned, and how he built the answer. Null while he knows no words.
 * If your message has a cue he has learned an answer to, he starts from that answer, and says a whole answer
 * people gave when one fits (answers.ts). If not, and you didn't ask him anything, he sometimes asks you
 * something back. `words` is what he said in stored spellings, for learning from your answer to it.
 */
export function reply(sql: SqlStorage, heard: string[], on: Situation[], random: () => number = Math.random) {
  if (!exists(sql, "SELECT 1 FROM words LIMIT 1")) return null;
  const mind = loadMind(sql);
  const link = answerTo(sql, heard);
  const questions = Object.entries(mind.questions).map(([next, count]) => ({ next, count }));
  const seed: Why["seed"] = link
    ? { word: link.answer, from: "answer", cue: link.cue, lift: link.lift }
    : questions.length > 0 && !isQuestion(heard) && random() < ASK_CHANCE
      ? { word: pickWeighted(questions, random)!.next, from: "ask" }
      : startWord(sql, heard, on, random);

  const quote = link && quoteFor(sql, link);
  const words = quote ? quote.text.split(" ") : [seed.word];
  const steps: WhyStep[] = [];
  let [p2, p1] = [START, seed.word];
  while (!quote && words.length < MAX_REPLY) {
    const step = nextWord(sql, mind, p2, p1, random);
    steps.push(step);
    if (step.word === END) break;
    words.push(step.word);
    [p2, p1] = [p1, step.word];
  }
  for (const w of new Set(words)) sql.exec("UPDATE words SET said = said + 1 WHERE word = ?", w);
  const babbleOnly = !quote && steps.every((s) => s.stop !== undefined);
  const why: Why = quote ? { on, seed, steps, quote: { words, times: quote.n } } : { on, seed, steps };
  return { text: babbleOnly ? `${words.join(" ")} beep` : words.join(" "), words, why };
}

/** A reply in the spellings most people use with Ohm: "gak" if most write "gak", "tidak" if most write "tidak". */
export function inStyle<T extends { text: string; why: Why }>(sql: SqlStorage, lexicon: Lexicon, said: T): T {
  const { spellings } = loadMind(sql);
  const say = (w: string) => lexicon.spellings(w).reduce((a, b) => ((spellings[b] ?? 0) > (spellings[a] ?? 0) ? b : a));
  const sayAll = (text: string) => text.split(" ").map(say).join(" ");
  const { seed, steps, quote } = said.why;
  const why: Why = {
    ...said.why,
    seed: seed.cue ? { ...seed, word: say(seed.word), cue: sayAll(seed.cue) } : { ...seed, word: say(seed.word) },
    steps: steps.map((s) => ({ ...s, word: say(s.word) })),
  };
  if (quote) why.quote = { ...quote, words: quote.words.map(say) };
  return { ...said, text: sayAll(said.text), why };
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