import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveWord, blockWord, overview, parseAdminCommand, unblockWord } from "../src/admin";
import { hear } from "../src/brain";
import { DEFAULT_SETTINGS } from "../src/protocol";
import { migrate } from "../src/schema";
import { makeLexicon } from "../src/words";
import { count, emptySql, testSql } from "./sql";

vi.mock("../src/wasm", async () => {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(new URL("../src/pet.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  return { math: instance.exports };
});

const RINA = { id: "visitor-rina", name: "Rina", ipHash: "0123456789abcdef" };
const T0 = Date.UTC(2026, 9, 1);
const lexicon = makeLexicon({ id: "aku\nsuka\nkopi", en: "" }, "");

let sql: SqlStorage;
beforeEach(() => {
  sql = testSql();
});

describe("parseAdminCommand", () => {
  it("accepts well-formed commands", () => {
    expect(parseAdminCommand("approve", { word: "wkwk", lang: "id" })).toEqual({ do: "approve", word: "wkwk", lang: "id" });
    expect(parseAdminCommand("ban", { ipHash: "0123456789abcdef" })).toEqual({ do: "ban", ipHash: "0123456789abcdef" });
    expect(parseAdminCommand("settings", { chargeHours: 24, moodHours: 12.5 })).toEqual({
      do: "settings",
      settings: { chargeHours: 24, moodHours: 12.5 },
    });
  });

  it("rejects anything else", () => {
    const bad: [string, unknown][] = [
      ["explode", {}],
      ["approve", { word: "wkwk", lang: "fr" }],
      ["block", { word: "two words" }],
      ["block", { word: "Kopi" }], // words are always lowercase
      ["ban", { ipHash: "1.2.3.4" }],
      ["dismiss", { id: -1 }],
      ["settings", { chargeHours: 0, moodHours: 12 }], // 0 hours would mean infinite speed
      ["settings", { chargeHours: 169, moodHours: 12 }],
      ["settings", { chargeHours: "24", moodHours: 12 }],
      ["settings", { chargeHours: Number.NaN, moodHours: 12 }],
      ["settings", null],
    ];
    for (const [action, body] of bad) expect(parseAdminCommand(action, body)).toBeNull();
  });
});

describe("word moderation", () => {
  it("approving a queued word teaches it to Ohm", () => {
    hear(sql, lexicon, ["wkwk"], RINA, T0);
    approveWord(sql, "wkwk", "id", T0);
    expect(count(sql, "SELECT COUNT(*) AS n FROM pending")).toBe(0);
    expect(sql.exec("SELECT langs, by_name FROM words WHERE word = 'wkwk'").one()).toEqual({ langs: "id", by_name: "admin" });
  });

  it("blocking a word makes Ohm forget it everywhere and never learn it again", () => {
    hear(sql, lexicon, ["aku", "suka", "kopi"], RINA, T0);
    blockWord(sql, "suka");
    expect(count(sql, "SELECT COUNT(*) AS n FROM words WHERE word = 'suka'")).toBe(0);
    expect(count(sql, "SELECT COUNT(*) AS n FROM grams WHERE 'suka' IN (p2, p1, next)")).toBe(0);
    expect(hear(sql, lexicon, ["suka"], RINA, T0).blocked).toBe(true);
    unblockWord(sql, "suka");
    expect(hear(sql, lexicon, ["suka"], RINA, T0).learned).toEqual(["suka"]);
  });

  it("the overview lists what needs your attention", () => {
    hear(sql, lexicon, ["aku", "wkwk"], RINA, T0);
    const o = overview(sql, DEFAULT_SETTINGS);
    expect(o.pending).toEqual([{ word: "wkwk", seen: 1 }]);
    expect(o.words).toEqual([{ word: "aku", by: "Rina", ipHash: "0123456789abcdef", at: T0 }]);
    expect(o.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("migrate", () => {
  it("upgrades the live Phase 2 database (old tables, no schema number) without losing data", () => {
    const old = emptySql();
    old.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
    old.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, at INTEGER, type TEXT, who_id TEXT, who_name TEXT)");
    old.exec("INSERT INTO events (at, type, who_id, who_name) VALUES (1, 'charge', 'x', 'IQBAL')");
    migrate(old);
    expect(old.exec("SELECT who_name, detail FROM events").one()).toEqual({ who_name: "IQBAL", detail: null });
    expect(old.exec("SELECT value FROM kv WHERE key = 'schema'").one()).toEqual({ value: "4" });
  });

  it("runs each step once, so running it again changes nothing", () => {
    migrate(sql); // testSql() already migrated once
    expect(sql.exec("SELECT value FROM kv WHERE key = 'schema'").one()).toEqual({ value: "4" });
  });
});