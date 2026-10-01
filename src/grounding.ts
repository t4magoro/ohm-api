// Which words belong to which situation: "hujan" → rain, "tidur" → malam. Ohm counts in which situations
// each word is said, and believes a link only when Dunning's G² says it's no coincidence (p < 0.001).
// Plain PMI and the Wilson bound linked far too many one-off coincidences (brain_sim.ipynb, section 11).
import type { Mind } from "./mind";
import type { Situation } from "./situation";

const G2_MIN = 10.83; // p < 0.001 for χ² with 1 degree of freedom, chosen on separate tuning runs

/** Dunning's log-likelihood ratio for a 2×2 table: 0 = no relation, bigger = less likely to be chance. */
export function g2(k11: number, k12: number, k21: number, k22: number) {
  const n = k11 + k12 + k21 + k22;
  const t = (k: number, row: number, col: number) => (k > 0 ? k * Math.log((k * n) / (row * col)) : 0);
  const [r1, r2, c1, c2] = [k11 + k12, k21 + k22, k11 + k21, k12 + k22];
  return 2 * (t(k11, r1, c1) + t(k12, r1, c2) + t(k21, r2, c1) + t(k22, r2, c2));
}

/** One sighting of `word` while the situations `on` were on. The caller applies the visitor rule. */
export function countSighting(sql: SqlStorage, mind: Mind, word: string, on: Situation[]) {
  mind.sightings += 1;
  for (const s of on) {
    mind.seenIn[s] = (mind.seenIn[s] ?? 0) + 1;
    sql.exec(
      "INSERT INTO word_ctx (word, situation, n) VALUES (?, ?, 1) ON CONFLICT (word, situation) DO UPDATE SET n = n + 1",
      word,
      s,
    );
  }
}

/**
 * Re-checks one word's link. For each situation it was said in, a 2×2 table of sightings
 * (this word or not × situation on or off). The link goes to the most significant situation
 * that the word makes *more* likely, if any passes G2_MIN.
 */
export function relink(sql: SqlStorage, mind: Mind, word: string) {
  const seen = sql.exec<{ seen: number }>("SELECT seen FROM words WHERE word = ?", word).one().seen;
  let best: { situation: Situation; g2: number; lift: number } | undefined;
  const rows = sql.exec<{ situation: Situation; n: number }>("SELECT situation, n FROM word_ctx WHERE word = ?", word);
  for (const { situation, n } of rows.toArray()) {
    const on = mind.seenIn[situation] ?? 0;
    const lift = n / seen / (on / mind.sightings); // how many times more likely the situation is when the word is said
    const score = g2(n, seen - n, on - n, mind.sightings - seen - on + n);
    // n >= 2: one sighting can be chance however rare the situation, so a link needs two different browsers
    if (n >= 2 && lift >= 1 && score >= G2_MIN && (!best || score > best.g2)) best = { situation, g2: score, lift };
  }
  if (best) {
    sql.exec(
      `INSERT INTO links (word, situation, g2, lift) VALUES (?, ?, ?, ?)
       ON CONFLICT (word) DO UPDATE SET situation = excluded.situation, g2 = excluded.g2, lift = excluded.lift`,
      word,
      best.situation,
      best.g2,
      best.lift,
    );
  } else {
    sql.exec("DELETE FROM links WHERE word = ?", word);
  }
}

/** The situation a word is linked to, if any. */
export const linkOf = (sql: SqlStorage, word: string) =>
  sql.exec<{ situation: Situation }>("SELECT situation FROM links WHERE word = ?", word).toArray()[0]?.situation;

/** The word most clearly tied to what's on right now, if Ohm has one, with its situation and lift. */
export function situationWord(sql: SqlStorage, on: Situation[]) {
  if (on.length === 0) return undefined;
  return sql
    .exec<{ word: string; situation: Situation; lift: number }>(
      `SELECT word, situation, lift FROM links WHERE situation IN (${on.map(() => "?").join(",")}) ORDER BY g2 DESC LIMIT 1`,
      ...on,
    )
    .toArray()[0];
}