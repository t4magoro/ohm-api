import { beforeEach, describe, expect, it, vi } from "vitest";
import { brainStats, hear, reply } from "../src/brain";
import { makeLexicon } from "../src/words";
import { count, testSql } from "./sql";

// In the Worker, wrangler loads pet.wasm. In tests, Node loads the same compiled C++.
vi.mock("../src/wasm", async () => {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(new URL("../src/pet.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  return { math: instance.exports };
});

const RINA = { id: "visitor-rina", name: "Rina", ipHash: "0123456789abcdef" };
const T0 = Date.UTC(2026, 9, 1);
// A tiny lexicon: "badword" stands in for a real blocked word.
const lexicon = makeLexicon({ id: "aku\nsuka\nkopi\nhujan", en: "i\nlike\ncoffee\nkopi" }, "badword");

let sql: SqlStorage;
beforeEach(() => {
  sql = testSql();
});

describe("hear", () => {
  it("learns allowed words and remembers who taught them", () => {
    expect(hear(sql, lexicon, ["aku", "suka", "kopi"], RINA, T0)).toEqual({ blocked: false, learned: ["aku", "suka", "kopi"] });
    expect(sql.exec("SELECT by_name, langs, ip_hash FROM words WHERE word = 'kopi'").one()).toEqual({
      by_name: "Rina",
      langs: "id,en",
      ip_hash: "0123456789abcdef",
    });
    expect(hear(sql, lexicon, ["aku", "kopi"], RINA, T0).learned).toEqual([]); // already known
  });

  it("one blocked word rejects the whole message", () => {
    expect(hear(sql, lexicon, ["aku", "badword"], RINA, T0).blocked).toBe(true);
    expect(count(sql, "SELECT COUNT(*) AS n FROM words")).toBe(0);
    expect(count(sql, "SELECT COUNT(*) AS n FROM grams")).toBe(0);
  });

  it("words you blocked on the admin page are rejected too", () => {
    sql.exec("INSERT INTO blocked (word) VALUES ('kopi')");
    expect(hear(sql, lexicon, ["aku", "kopi"], RINA, T0).blocked).toBe(true);
  });

  it("unknown words wait for approval and split the sentence", () => {
    hear(sql, lexicon, ["aku", "xyzzy", "kopi"], RINA, T0);
    expect(sql.exec("SELECT word, seen FROM pending").toArray()).toEqual([{ word: "xyzzy", seen: 1 }]);
    expect(count(sql, "SELECT COUNT(*) AS n FROM grams WHERE p1 = 'aku' AND next = 'kopi'")).toBe(0);
  });
});

describe("reply", () => {
  it("says nothing before Ohm knows any word", () => {
    expect(reply(sql, ["halo"])).toBeNull();
  });

  it("babbles known words at level 1", () => {
    hear(sql, lexicon, ["aku", "suka", "kopi"], RINA, T0);
    const words = reply(sql, [], () => 0.5)!.split(" ");
    expect(words.at(-1)).toBe("beep");
    for (const w of words.slice(0, -1)) expect(["aku", "suka", "kopi"]).toContain(w);
  });

  it("follows what it learned from level 2 on, and never says an unknown word", () => {
    // 60 filler words push the vocabulary past 50, which is brain level 2.
    const filler = Array.from({ length: 60 }, (_, i) => `w${String.fromCharCode(97 + (i % 26))}${i}`);
    const everything = makeLexicon({ id: filler.join("\n") + "\naku\nsuka\nkopi", en: "" }, "");
    for (let i = 0; i < filler.length; i += 10) hear(sql, everything, filler.slice(i, i + 10), RINA, T0);
    hear(sql, everything, ["aku", "suka", "kopi"], RINA, T0);
    expect(brainStats(sql).level).toBe(2);
    expect(reply(sql, ["aku"], () => 0.5)).toBe("aku suka kopi");
  });

  it("counts how often Ohm said each word", () => {
    hear(sql, lexicon, ["kopi"], RINA, T0);
    reply(sql, ["kopi"], () => 0);
    expect(sql.exec("SELECT said FROM words WHERE word = 'kopi'").one()).toEqual({ said: 1 });
  });
});

describe("brainStats", () => {
  it("counts words per language", () => {
    hear(sql, lexicon, ["aku", "suka", "kopi", "i", "like"], RINA, T0);
    expect(brainStats(sql)).toEqual({
      vocab: 5,
      level: 1,
      langs: { id: { words: 3, level: 0 }, en: { words: 3, level: 0 } }, // "kopi" is in both lists
    });
  });
});