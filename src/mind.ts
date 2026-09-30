// Ohm's skills, and the counters his brain needs, in one kv row ("mind"). A skill is measured on every
// message *before* Ohm learns from it, so every message is new to him: a fair test.
import { kvGet, kvSet } from "./kv";
import type { Skills } from "./protocol";
import type { Situation } from "./situation";

const SKILL_WINDOW = 100; // a skill is the average of about the last 100 observations

export type Mind = {
  skills: Skills;
  tokens: number; // known words heard
  ends: number; // sentence ends heard: how often babble stops
  sightings: number; // word sightings, for grounding (see brain.ts, the visitor rule)
  seenIn: Partial<Record<Situation, number>>; // how many of them happened while each situation was on
};

const sum = (sql: SqlStorage, query: string) => sql.exec<{ n: number | null }>(query).one().n ?? 0;

export function loadMind(sql: SqlStorage): Mind {
  return (
    kvGet<Mind>(sql, "mind") ?? {
      skills: { words: 0, sentences: 0, context: 0, expression: 0 },
      // An Ohm that learned before this brain existed: start the babble counters from his tables, once.
      tokens: sum(sql, "SELECT SUM(uses) AS n FROM words"),
      ends: sum(sql, "SELECT SUM(count) AS n FROM grams WHERE next = '</s>'"),
      sightings: 0,
      seenIn: {},
    }
  );
}

export const saveMind = (sql: SqlStorage, mind: Mind) => kvSet(sql, "mind", mind);

/** Ohm's skills, 0 to 1. */
export const skills = (sql: SqlStorage) => loadMind(sql).skills;

/** One more observation: the skill moves 1/100 of the way toward hit (1) or miss (0). */
export function bump(mind: Mind, skill: keyof Skills, hit: boolean) {
  mind.skills[skill] += (Number(hit) - mind.skills[skill]) / SKILL_WINDOW;
}

/** A visitor patted (true) or frowned at (false) Ohm's reply to them. It moves the Expression skill only. */
export function rate(sql: SqlStorage, pat: boolean) {
  const mind = loadMind(sql);
  bump(mind, "expression", pat);
  saveMind(sql, mind);
}