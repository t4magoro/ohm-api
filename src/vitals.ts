// Ohm's history: hourly snapshots and the Vitals page, the milestones everyone works on
// together, and the "while you were away" summary. The tables and indexes are in schema.ts.
import { valueNow } from "./pet";
import {
  MILESTONES,
  type Brain,
  type Counts,
  type MilestoneId,
  type MilestoneProgress,
  type Pet,
  type Snapshot,
  type Vitals,
} from "./protocol";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const BANDUNG = 7 * HOUR; // Bandung is UTC+7 all year: Indonesia has no daylight saving

const count = (sql: SqlStorage, query: string, ...params: (string | number)[]) =>
  sql.exec<{ n: number }>(query, ...params).one().n;

/** Saves Ohm's stats once per hour. The 15-minute alarm calls this; only the first call in each hour writes. */
export function snapshot(sql: SqlStorage, pet: Pet, vocab: number, online: number, now: number) {
  sql.exec(
    "INSERT INTO snapshots (at, charge, mood, vocab, online) VALUES (?, ?, ?, ?, ?) ON CONFLICT (at) DO NOTHING",
    now - (now % HOUR),
    valueNow(pet.charge, now),
    valueNow(pet.mood, now),
    vocab,
    online,
  );
}

/** Where Ohm stands on each milestone right now. Cheap: it reads no table. */
export function standing(pet: Pet, vocab: number, now: number): Record<Counts, number> {
  return { words: vocab, days: pet.status === "on" ? (now - pet.bornAt) / DAY : 0, charges: pet.charges };
}

/** The milestones that are reached now but weren't unlocked yet. */
export const reached = (s: Record<Counts, number>, unlocked: MilestoneId[]) =>
  MILESTONES.filter((m) => !unlocked.includes(m.id) && s[m.counts] >= m.goal).map((m) => m.id);

/**
 * How far each milestone is, and the days left: remaining ÷ progress per day.
 * The pace is measured over the last 7 days, or over Ohm's whole history while that's shorter
 * (but at least 1 day, so a busy first hour doesn't promise too much).
 */
export function progress(sql: SqlStorage, s: Record<Counts, number>, unlocked: MilestoneId[], now: number): MilestoneProgress[] {
  const first = sql.exec<{ at: number }>("SELECT at FROM events ORDER BY id LIMIT 1").toArray()[0]?.at ?? now;
  const days = Math.min(7, Math.max(1, (now - first) / DAY));
  const since = now - days * DAY;
  const perDay: Record<Counts, number> = {
    words: count(sql, "SELECT COUNT(*) AS n FROM words WHERE at > ?", since) / days,
    charges: count(sql, "SELECT COUNT(*) AS n FROM events WHERE type = 'charge' AND at > ?", since) / days,
    days: s.days > 0 ? 1 : 0, // time counts 1 day per day, as long as Ohm stays on
  };
  return MILESTONES.map((m) => {
    const done = unlocked.includes(m.id);
    const etaDays = done || perDay[m.counts] === 0 ? null : Math.max(0, m.goal - s[m.counts]) / perDay[m.counts];
    return { id: m.id, value: s[m.counts], done, etaDays };
  });
}

/** Everything the Vitals page shows. Some queries read whole tables: the Durable Object caches the result. */
export function vitals(sql: SqlStorage, s: Record<Counts, number>, unlocked: MilestoneId[], brain: Brain, now: number): Vitals {
  const week = now - WEEK;
  // How busy each hour of the day is (Bandung time): care actions plus chat messages.
  const hours = Array<number>(24).fill(0);
  const busy = sql
    .exec<{ hour: number; n: number }>(
      `SELECT CAST((at + ${BANDUNG}) / ${HOUR} AS INTEGER) % 24 AS hour, COUNT(*) AS n FROM (
         SELECT at FROM events WHERE type IN ('charge', 'play', 'reboot') AND at > ?
         UNION ALL SELECT at FROM lines WHERE at > ?
       ) GROUP BY hour`,
      week,
      week,
    )
    .toArray();
  for (const { hour, n } of busy) hours[hour] = n;

  return {
    snapshots: sql
      .exec<Snapshot>("SELECT at, charge, mood, vocab, online FROM snapshots WHERE at > ? ORDER BY at", week)
      .toArray(),
    hours,
    growth: sql
      .exec<{ day: string; words: number }>(
        `SELECT date((at + ${BANDUNG}) / 1000, 'unixepoch') AS day, COUNT(*) AS words FROM words GROUP BY day ORDER BY day`,
      )
      .toArray(),
    topWords: sql
      .exec<Vitals["topWords"][number]>(
        `SELECT word, uses, said, by_name AS "by" FROM words ORDER BY uses DESC, said DESC LIMIT 10`,
      )
      .toArray(),
    milestones: progress(sql, s, unlocked, now),
    brain,
    now,
  };
}

/** "While you were away": what happened since your last visit, and how often Ohm has said the words you taught. */
export function away(sql: SqlStorage, visitorId: string, lastSeen: number) {
  return {
    learned: count(sql, "SELECT COUNT(*) AS n FROM words WHERE at > ?", lastSeen),
    shutdowns: count(sql, "SELECT COUNT(*) AS n FROM events WHERE type = 'shutdown' AND at > ?", lastSeen),
    said: count(sql, "SELECT COALESCE(SUM(said), 0) AS n FROM words WHERE by_id = ?", visitorId),
  };
}