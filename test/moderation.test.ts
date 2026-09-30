import { beforeEach, describe, expect, it, vi } from "vitest";
import { hear } from "../src/brain";
import {
  approveWord,
  ban,
  blockWord,
  dismissReport,
  fileReport,
  isBanned,
  overview,
  resetBrain,
  search,
  unban,
  unblockWord,
  unsay,
} from "../src/moderation";
import { DEFAULT_SETTINGS } from "../src/protocol";
import type { Situation } from "../src/situation";
import { makeLexicon } from "../src/words";
import { count, testSql } from "./sql";

vi.mock("../src/wasm", async () => {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(new URL("../src/pet.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  return { math: instance.exports };
});

const RINA = { id: "visitor-rina", name: "Rina", ipHash: "0123456789abcdef" };
const T0 = Date.UTC(2026, 9, 1);
const lexicon = makeLexicon({ id: "aku\nsuka\nkopi", en: "" }, "");
const DRY: Situation[] = ["siang"];

let sql: SqlStorage;
beforeEach(() => {
  sql = testSql();
});

describe("word moderation", () => {
  it("approving a queued word teaches it to Ohm", () => {
    hear(sql, lexicon, ["wkwk"], RINA, T0, DRY);
    approveWord(sql, "wkwk", "id", T0);
    expect(count(sql, "SELECT COUNT(*) AS n FROM pending")).toBe(0);
    expect(sql.exec("SELECT langs, by_name FROM words WHERE word = 'wkwk'").one()).toEqual({ langs: "id", by_name: "admin" });
  });

  it("blocking a word makes Ohm forget it everywhere and never learn it again", () => {
    hear(sql, lexicon, ["aku", "suka", "kopi"], RINA, T0, DRY);
    blockWord(sql, "suka");
    expect(count(sql, "SELECT COUNT(*) AS n FROM words WHERE word = 'suka'")).toBe(0);
    expect(count(sql, "SELECT COUNT(*) AS n FROM grams WHERE 'suka' IN (p2, p1, next)")).toBe(0);
    expect(count(sql, "SELECT COUNT(*) AS n FROM word_ctx WHERE word = 'suka'")).toBe(0);
    expect(hear(sql, lexicon, ["suka"], RINA, T0, DRY).blocked).toBe(true);
    unblockWord(sql, "suka");
    expect(hear(sql, lexicon, ["suka"], RINA, T0, DRY).learned).toEqual(["suka"]);
  });

  it("the overview lists what needs your attention", () => {
    hear(sql, lexicon, ["aku", "wkwk"], RINA, T0, DRY);
    const o = overview(sql, DEFAULT_SETTINGS);
    expect(o.pending).toEqual([{ word: "wkwk", seen: 1 }]);
    expect(o.words).toEqual([{ word: "aku", by: "Rina", ipHash: "0123456789abcdef", at: T0 }]);
    expect(o.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("search finds a word in every list, and % or _ only match themselves", () => {
    hear(sql, lexicon, ["aku", "suka", "wkwk"], RINA, T0, DRY);
    blockWord(sql, "kopi");
    const found = search(sql, "k");
    expect(found.words.map((w) => w.word)).toEqual(["aku", "suka"]);
    expect(found.pending).toEqual([{ word: "wkwk", seen: 1 }]);
    expect(found.blocked).toEqual([{ word: "kopi" }]);
    expect(search(sql, "%").words).toEqual([]);
    expect(search(sql, "_").words).toEqual([]);
  });
});

describe("reset", () => {
  it("wipes everything Ohm learned and keeps moderation and history", () => {
    hear(sql, lexicon, ["aku", "suka", "wkwk"], RINA, T0, DRY);
    blockWord(sql, "kopi");
    ban(sql, RINA.ipHash, T0);
    sql.exec("INSERT INTO lines (at, text, to_name, ip_hash) VALUES (?, 'aku suka', 'Rina', ?)", T0, RINA.ipHash);
    resetBrain(sql);
    for (const table of ["words", "pending", "grams", "word_ctx", "links"]) {
      expect(count(sql, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
    }
    expect(count(sql, "SELECT COUNT(*) AS n FROM kv WHERE key IN ('brain', 'mind')")).toBe(0);
    expect(count(sql, "SELECT COUNT(*) AS n FROM blocked")).toBe(1);
    expect(isBanned(sql, RINA.ipHash)).toBe(true);
    expect(count(sql, "SELECT COUNT(*) AS n FROM lines")).toBe(1);
    expect(hear(sql, lexicon, ["aku"], RINA, T0, DRY).learned).toEqual(["aku"]); // learns again from zero
  });
});

describe("bans and reports", () => {
  it("bans come and go, and a report follows its line", () => {
    ban(sql, RINA.ipHash, T0);
    expect(isBanned(sql, RINA.ipHash)).toBe(true);
    unban(sql, RINA.ipHash);
    expect(isBanned(sql, RINA.ipHash)).toBe(false);

    expect(fileReport(sql, 1, RINA.id, T0)).toBe(false); // no such line
    sql.exec("INSERT INTO lines (at, text, to_name, ip_hash) VALUES (?, 'aku suka', 'Rina', ?)", T0, RINA.ipHash);
    expect(fileReport(sql, 1, RINA.id, T0)).toBe(true);
    expect(fileReport(sql, 1, RINA.id, T0)).toBe(true);
    const [first] = overview(sql, DEFAULT_SETTINGS).reports;
    dismissReport(sql, first.id);
    expect(overview(sql, DEFAULT_SETTINGS).reports).toHaveLength(1);
    unsay(sql, 1); // deleting the line takes its reports with it
    expect(count(sql, "SELECT COUNT(*) AS n FROM lines")).toBe(0);
    expect(overview(sql, DEFAULT_SETTINGS).reports).toEqual([]);
  });
});
