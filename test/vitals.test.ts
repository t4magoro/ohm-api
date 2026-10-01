import { beforeEach, describe, expect, it, vi } from "vitest";
import { catchUp, newPet } from "../src/pet";
import { DEFAULT_SETTINGS } from "../src/protocol";
import { away, progress, reached, snapshot, standing, vitals } from "../src/vitals";
import { testSql } from "./sql";

vi.mock("../src/wasm", async () => {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(new URL("../src/pet.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  return { math: instance.exports };
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1); // 07:00 in Bandung
const SUNNY = { weather: { tempC: 27, raining: false, isDay: true }, settings: DEFAULT_SETTINGS };
const BRAIN = {
  vocab: 0,
  langs: { id: { words: 0 }, en: { words: 0 } },
  skills: { words: 0, sentences: 0, context: 0, expression: 0 },
};

let sql: SqlStorage;
beforeEach(() => {
  sql = testSql();
});

const event = (at: number, type: string, who = "visitor-rina") =>
  sql.exec("INSERT INTO events (at, type, who_id, who_name) VALUES (?, ?, ?, 'Rina')", at, type, who);
const word = (word: string, at: number, said = 0, uses = 1, by = "visitor-rina") =>
  sql.exec(
    "INSERT INTO words (word, langs, by_id, by_name, at, uses, said) VALUES (?, 'id', ?, 'Rina', ?, ?, ?)",
    word,
    by,
    at,
    uses,
    said,
  );

describe("snapshot", () => {
  it("saves one row per hour, stamped with the start of the hour", () => {
    const pet = newPet(T0, SUNNY);
        snapshot(sql, pet, { ...BRAIN, vocab: 3, skills: { ...BRAIN.skills, words: 0.5 } }, 2, T0 + 10 * 60_000);
    snapshot(sql, pet, { ...BRAIN, vocab: 4 }, 9, T0 + 25 * 60_000); // same hour: ignored
    snapshot(sql, pet, { ...BRAIN, vocab: 5 }, 1, T0 + HOUR + 60_000);
    expect(sql.exec("SELECT at, vocab, online, skill_words FROM snapshots ORDER BY at").toArray()).toEqual([
      { at: T0, vocab: 3, online: 2, skill_words: 0.5 },
      { at: T0 + HOUR, vocab: 5, online: 1, skill_words: 0 },
    ]);
    const { charge } = sql.exec<{ charge: number }>("SELECT charge FROM snapshots WHERE at = ?", T0 + HOUR).one();
    expect(charge).toBeCloseTo(100 - 5 * (61 / 60)); // the value at that moment, not at the start of the hour
  });
});

describe("milestones", () => {
  it("unlock once the count is reached, and only once", () => {
    const pet = newPet(T0, SUNNY);
    expect(reached(standing(pet, 99, T0), [])).toEqual([]);
    expect(reached(standing(pet, 100, T0), [])).toEqual(["antenna"]);
    expect(reached(standing(pet, 100, T0), ["antenna"])).toEqual([]);
    expect(reached(standing(pet, 0, T0 + 7 * DAY), [])).toEqual(["hat"]);
    expect(reached(standing({ ...pet, charges: 1000 }, 0, T0), [])).toEqual(["jetpack"]);
  });

  it("an Ohm that's off isn't alive for any days", () => {
    const pet = newPet(T0, SUNNY);
    catchUp(pet, T0 + 30 * HOUR);
    expect(standing(pet, 0, T0 + 30 * HOUR).days).toBe(0);
  });

  it("estimate the days left at this week's pace", () => {
    const now = T0 + 10 * DAY;
    event(T0, "charge"); // Ohm's first event, 10 days ago: older than a week
    for (let i = 0; i < 14; i++) word(`w${i}`, now - DAY); // 14 words this week = 2 a day
    for (let i = 0; i < 70; i++) event(now - DAY, "charge"); // 70 charges this week = 10 a day
    const pet = { ...newPet(now - 3 * DAY, SUNNY), charges: 500 };
    const [antenna, hat, jetpack] = progress(sql, standing(pet, 60, now), [], now);
    expect(antenna).toEqual({ id: "antenna", value: 60, done: false, etaDays: 20 }); // 40 words ÷ 2 a day
    expect(hat).toEqual({ id: "hat", value: 3, done: false, etaDays: 4 });
    expect(jetpack).toEqual({ id: "jetpack", value: 500, done: false, etaDays: 50 }); // 500 ÷ 10 a day
  });

  it("measure the pace over Ohm's whole history while it's younger than a week", () => {
    const now = T0 + 2 * DAY;
    event(T0, "charge");
    for (let i = 0; i < 10; i++) word(`w${i}`, T0 + DAY); // 10 words in 2 days = 5 a day
    const [antenna] = progress(sql, standing(newPet(T0, SUNNY), 10, now), [], now);
    expect(antenna.etaDays).toBe(18); // 90 words ÷ 5 a day
  });

  it("have no estimate once unlocked, or without progress", () => {
    const now = T0 + DAY;
    const [antenna, , jetpack] = progress(sql, standing(newPet(T0, SUNNY), 120, now), ["antenna"], now);
    expect(antenna).toMatchObject({ done: true, etaDays: null });
    expect(jetpack.etaDays).toBeNull(); // nobody charged Ohm this week
  });
});

describe("vitals", () => {
  it("counts busy hours in Bandung time, from actions and chats of the last 7 days", () => {
    const now = T0 + 7 * DAY + HOUR;
    const eight = T0 + DAY + HOUR + 5 * 60_000; // 08:05 in Bandung
    event(eight, "charge");
    event(eight, "play");
    event(eight, "shutdown"); // Ohm's own event: not counted
    event(T0, "charge"); // more than 7 days ago: not counted
    sql.exec("INSERT INTO lines (at, text, to_name) VALUES (?, 'halo', 'Rina')", eight);
    const v = vitals(sql, standing(newPet(T0, SUNNY), 0, now), [], BRAIN, now);
    expect(v.hours[8]).toBe(3);
    expect(v.hours.reduce((a, b) => a + b)).toBe(3);
  });

  it("groups new words by Bandung date and lists the most used words", () => {
    word("aku", Date.UTC(2026, 8, 29, 16, 59), 1, 5); // 23:59 on the 29th in Bandung
    word("kopi", Date.UTC(2026, 8, 29, 17, 0), 7, 9); // 00:00 on the 30th in Bandung
    word("suka", Date.UTC(2026, 8, 29, 18, 0), 0, 2);
    const v = vitals(sql, standing(newPet(T0, SUNNY), 3, T0), [], BRAIN, T0);
    expect(v.growth).toEqual([
      { day: "2026-09-29", words: 1 },
      { day: "2026-09-30", words: 2 },
    ]);
    expect(v.topWords[0]).toEqual({ word: "kopi", uses: 9, said: 7, by: "Rina" });
  });

  it("returns each hour's skills, or null for snapshots from before brain v2", () => {
    const skills = { words: 0.5, sentences: 0.25, context: 0, expression: 1 };
    snapshot(sql, newPet(T0, SUNNY), { ...BRAIN, skills }, 1, T0);
    sql.exec("INSERT INTO snapshots (at, charge, mood, vocab, online) VALUES (?, 50, 50, 3, 0)", T0 + HOUR); // an old row
    const now = T0 + 2 * HOUR;
    const v = vitals(sql, standing(newPet(T0, SUNNY), 0, now), [], BRAIN, now);
    expect(v.snapshots.map((s) => s.skills)).toEqual([skills, null]);
  });

    it("lists the strongest links first, at most 12", () => {
    for (let i = 0; i < 14; i++) sql.exec("INSERT INTO links (word, situation, g2, lift) VALUES (?, 'rain', ?, 2)", `w${i}`, 20 + i);
    const v = vitals(sql, standing(newPet(T0, SUNNY), 3, T0), [], BRAIN, T0);
    expect(v.links.map((l) => l.word)).toEqual(Array.from({ length: 12 }, (_, i) => `w${13 - i}`));
    expect(v.links[0]).toEqual({ word: "w13", situation: "rain", lift: 2 });
  });
});

describe("away", () => {
  it("counts what happened since your last visit, and how often Ohm said your words", () => {
    word("aku", T0 - DAY, 3);
    word("kopi", T0 + HOUR, 4);
    word("hujan", T0 + HOUR, 5, 1, "visitor-budi");
    event(T0 + 2 * HOUR, "shutdown");
    event(T0 - DAY, "shutdown");
    expect(away(sql, "visitor-rina", T0)).toEqual({ learned: 2, shutdowns: 1, said: 7 });
    expect(away(sql, "someone-new", T0).said).toBe(0);
  });
});