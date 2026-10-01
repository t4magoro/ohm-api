import { beforeEach, describe, expect, it, vi } from "vitest";
import { brainStats, follow, hear, reply } from "../src/brain";
import { g2 } from "../src/grounding";
import { markRated } from "../src/history";
import { rate, skills } from "../src/mind";
import type { Situation } from "../src/situation";
import { makeLexicon } from "../src/words";
import { count, testSql } from "./sql";

// In the Worker, wrangler loads pet.wasm. In tests, Node loads the same compiled C++.
vi.mock("../src/wasm", async () => {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(new URL("../src/pet.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  return { math: instance.exports };
});

const visitor = (n: number) => ({ id: `visitor-${n}`, name: `V${n}`, ipHash: n.toString(16).padStart(16, "0") });
const RINA = visitor(1);
const BUDI = visitor(2);
const CITRA = visitor(3);
const T0 = Date.UTC(2026, 9, 1);
const DRY: Situation[] = ["siang"];
const RAIN: Situation[] = ["siang", "rain"];
// A tiny lexicon: "badword" stands in for a real blocked word.
const lexicon = makeLexicon({ id: "aku\nsuka\nkopi\nhujan\nteh", en: "i\nlike\ncoffee\nkopi" }, "badword");

let sql: SqlStorage;
beforeEach(() => {
  sql = testSql();
});
const say = (text: string, who = RINA, on = DRY) => hear(sql, lexicon, text.split(" "), who, T0, on);

describe("hear", () => {
  it("learns allowed words and remembers who taught them", () => {
    expect(say("aku suka kopi")).toEqual({ blocked: false, learned: ["aku", "suka", "kopi"] });
    expect(sql.exec("SELECT by_name, langs, ip_hash FROM words WHERE word = 'kopi'").one()).toEqual({
      by_name: "V1",
      langs: "id,en",
      ip_hash: RINA.ipHash,
    });
    expect(say("aku kopi").learned).toEqual([]); // already known
  });

  it("one blocked word rejects the whole message", () => {
    expect(say("aku badword").blocked).toBe(true);
    expect(count(sql, "SELECT COUNT(*) AS n FROM words")).toBe(0);
    expect(count(sql, "SELECT COUNT(*) AS n FROM grams")).toBe(0);
  });

  it("words you blocked on the admin page are rejected too", () => {
    sql.exec("INSERT INTO blocked (word) VALUES ('kopi')");
    expect(say("aku kopi").blocked).toBe(true);
  });

  it("unknown words wait for approval and split the sentence", () => {
    say("aku xyzzy kopi");
    expect(sql.exec("SELECT word, seen FROM pending").toArray()).toEqual([{ word: "xyzzy", seen: 1 }]);
    expect(count(sql, "SELECT COUNT(*) AS n FROM grams WHERE p1 = 'aku' AND next = 'kopi'")).toBe(0);
  });

  it("counts a pattern again only when a different visitor types it (the visitor rule)", () => {
    say("aku suka kopi");
    say("aku suka kopi"); // Rina again: nothing changes
    expect(count(sql, "SELECT MAX(count) AS n FROM grams")).toBe(1);
    expect(sql.exec("SELECT uses, seen FROM words WHERE word = 'kopi'").one()).toEqual({ uses: 2, seen: 1 });
    say("aku suka kopi", BUDI);
    say("aku suka kopi"); // Rina after Budi counts again
    expect(count(sql, "SELECT MIN(count) AS n FROM grams")).toBe(3);
  });

  it("scores each message before learning from it", () => {
    say("aku suka"); // both words new: two misses, no known pair yet
    expect(skills(sql)).toEqual({ words: 0, sentences: 0, context: 0, expression: 0 });
    say("aku suka kopi", BUDI); // aku, suka known (hit, hit), kopi new (miss);
    expect(skills(sql).words).toBeCloseTo(0.019701);
  });
});

describe("reply", () => {
  it("says nothing before Ohm knows any word", () => {
    expect(reply(sql, ["halo"], DRY)).toBeNull();
  });

  it("only babbles what a single visitor taught, however often", () => {
    for (let i = 0; i < 5; i++) say("aku suka kopi");
    for (const r of [0, 0.3, 0.6, 0.9]) expect(reply(sql, ["aku"], DRY, () => r)!.text).toMatch(/ beep$/);
    expect(skills(sql).sentences).toBe(0); // every word was babble
  });

  it("follows a pattern once two visitors typed it", () => {
    say("aku suka kopi");
    say("aku suka kopi", BUDI);
    expect(reply(sql, ["aku"], DRY, () => 0)!.text).toBe("aku suka kopi");
    expect(skills(sql).sentences).toBeCloseTo(0.029701); // suka, kopi and the end all came from patterns: 3 hits
  });

  it("never follows one visitor's word, even after a well-known start", () => {
    const afterAkuSuka = [
      { next: "kopi", count: 2 },
      { next: "teh", count: 1 },
    ];
    for (const r of [0, 0.1, 0.2, 0.33]) {
      expect(follow(afterAkuSuka, () => r)).toEqual({ chance: 1 / 3, followed: true, word: "kopi", share: 1 });
    }
    expect(follow(afterAkuSuka, () => 0.34)).toEqual({ chance: 1 / 3, followed: false }); // 2 of 3 times Ohm backs off to "suka" alone
    expect(follow([{ next: "teh", count: 1 }], () => 0)).toEqual({ chance: 0, followed: false });
  });

  it("never follows a word pair only one visitor typed, even after two different words", () => {
    say("aku kopi suka");
    say("hujan kopi suka"); // Rina typed "kopi suka" twice, after different words: still one visitor
    expect(count(sql, "SELECT count AS n FROM pairs WHERE p1 = 'kopi' AND next = 'suka'")).toBe(1);
    expect(reply(sql, ["kopi"], DRY, () => 0)!.text).toBe("kopi beep"); // adding up the triples would have said "kopi suka"
  });

  it("follows a word pair two visitors typed, even after different words", () => {
    say("aku kopi suka");
    say("hujan kopi suka", BUDI); // no triple has 2 visitors, but the pair "kopi suka" does
    expect(reply(sql, ["kopi"], DRY, () => 0)!.text).toBe("kopi suka");
  });

  it("counts how often Ohm said each word", () => {
    say("kopi");
    reply(sql, ["kopi"], DRY, () => 0);
    expect(sql.exec("SELECT said FROM words WHERE word = 'kopi'").one()).toEqual({ said: 1 });
  });
});

describe("why", () => {
  // The worked example: Rina and Budi typed "aku suka kopi", Citra typed "aku suka teh". Then someone types "aku".
  const example = () => {
    say("aku suka kopi");
    say("aku suka kopi", BUDI);
    say("aku suka teh", CITRA);
  };

  it("explains every word with the numbers Ohm used", () => {
    example();
    expect(reply(sql, ["aku"], DRY, () => 0)).toEqual({
      text: "aku suka kopi",
      why: {
        on: DRY,
        seed: { word: "aku", from: "topic" },
        steps: [
          { word: "suka", tried: [{ rung: "pair", chance: 2 / 3, followed: true }], share: 1 },
          { word: "kopi", tried: [{ rung: "pair", chance: 1 / 3, followed: true }], share: 1 }, // teh: weight 0
          { word: "</s>", tried: [{ rung: "pair", chance: 1 / 2, followed: true }], share: 1 },
        ],
      },
    });
  });

  it("never picks a word only one visitor taught, whatever the dice say", () => {
    example();
    for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
      const { steps } = reply(sql, ["aku"], DRY, () => r)!.why;
      for (const s of steps) if (s.stop === undefined) expect(s.word).not.toBe("teh"); // babble may say it: a single word
    }
  });

  it("shows babble: nothing to follow, and the chance to stop", () => {
    for (let i = 0; i < 5; i++) say("aku suka kopi"); // one visitor: 15 words, 5 sentence ends
    expect(reply(sql, ["aku"], DRY, () => 0)!.why.steps).toEqual([
      { word: "</s>", tried: [{ rung: "pair", chance: 0, followed: false }, { rung: "word", chance: 0, followed: false }], stop: 0.25 },
    ]);
  });
});

describe("grounding", () => {
  // Ten visitors chat when it's dry, so Ohm knows what "normal" looks like.
  const background = () => {
    for (let i = 10; i < 20; i++) say("aku suka kopi", visitor(i));
  };

  it("g2 is 0 without a relation and grows with it", () => {
    expect(g2(5, 5, 5, 5)).toBe(0);
    expect(g2(10, 0, 0, 10)).toBeCloseTo(40 * Math.log(2));
  });

  it("links a word to a situation once two different visitors used it there", () => {
    background();
    say("hujan", visitor(1), RAIN);
    expect(count(sql, "SELECT COUNT(*) AS n FROM links")).toBe(0); // one sighting could be chance (G² 8.8)
    say("hujan", visitor(1), RAIN); // the same visitor again doesn't count
    expect(count(sql, "SELECT COUNT(*) AS n FROM links")).toBe(0);
    say("hujan", visitor(2), RAIN);
    expect(sql.exec("SELECT word, situation FROM links").toArray()).toEqual([{ word: "hujan", situation: "rain" }]);
  });

  it("never links from a single sighting, however rare the situation", () => {
    for (let i = 10; i < 40; i++) say("aku suka kopi", visitor(i)); // 90 dry sightings
    say("hujan", visitor(1), RAIN); // alone, G² would be 11.0: past 10.83
    expect(count(sql, "SELECT COUNT(*) AS n FROM links")).toBe(0);
  });

  it("friends on one Wi-Fi teach situations, but not sentences", () => {
    background();
    const phone = (n: number) => ({ id: `phone-${n}`, name: `P${n}`, ipHash: "00000000000000aa" });
    say("hujan", phone(1), RAIN);
    say("hujan", phone(2), RAIN); // another browser on the same Wi-Fi
    expect(sql.exec("SELECT word, situation FROM links").toArray()).toEqual([{ word: "hujan", situation: "rain" }]);
    expect(count(sql, "SELECT MAX(count) AS n FROM grams WHERE p1 = 'hujan'")).toBe(1); // still one visitor for patterns
  });

  it("measures context: a linked word said while its situation is on", () => {
    background();
    say("hujan", visitor(1), RAIN);
    say("hujan", visitor(2), RAIN);
    say("hujan", visitor(3), RAIN); // linked, and it's raining: a hit
    expect(skills(sql).context).toBeCloseTo(0.01);
    say("hujan", visitor(4), DRY); // linked, but it's dry: a miss
    expect(skills(sql).context).toBeCloseTo(0.0099);
  });

  it("starts from his situation when nothing in your message is known", () => {
    background();
    say("hujan", visitor(1), RAIN);
    say("hujan", visitor(2), RAIN);
    const rainy = reply(sql, ["xyz"], RAIN, () => 0)!;
    expect(rainy.text.split(" ")[0]).toBe("hujan");
    expect(rainy.why.seed).toMatchObject({ word: "hujan", from: "situation", situation: "rain" });
    expect(rainy.why.seed.lift).toBeGreaterThan(1);
    expect(reply(sql, ["xyz"], DRY, () => 0)!.why.seed).toEqual({ word: "aku", from: "random" }); // no dry-weather word
  });
});

describe("rating", () => {
  it("only the visitor Ohm answered can rate a line, once", () => {
    sql.exec("INSERT INTO lines (at, text, to_name, ip_hash) VALUES (?, 'halo', 'V1', ?)", T0, RINA.ipHash);
    expect(markRated(sql, 1, BUDI.ipHash, true)).toBe(false);
    expect(markRated(sql, 1, RINA.ipHash, true)).toBe(true);
    expect(markRated(sql, 1, RINA.ipHash, false)).toBe(false); // already rated
    expect(markRated(sql, 2, RINA.ipHash, true)).toBe(false); // no such line
  });

  it("pats and frowns move the Expression skill", () => {
    rate(sql, true);
    expect(skills(sql).expression).toBeCloseTo(0.01);
    rate(sql, false);
    expect(skills(sql).expression).toBeCloseTo(0.0099);
  });
});

describe("mind", () => {
  it("an Ohm from before this brain starts his babble counters from his tables", () => {
    sql.exec("INSERT INTO words (word, langs, uses) VALUES ('kopi', 'id', 3)");
    sql.exec("INSERT INTO grams (p2, p1, next, count) VALUES ('suka', 'kopi', '</s>', 2)");
    rate(sql, true); // saves the mind for the first time
    const mind = JSON.parse(sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'mind'").one().value);
    expect(mind).toMatchObject({ tokens: 3, ends: 2, sightings: 0 });
  });
});

describe("brainStats", () => {
  it("counts words per language", () => {
    hear(sql, lexicon, ["aku", "suka", "kopi", "i", "like"], RINA, T0, DRY);
    expect(brainStats(sql)).toEqual({
      vocab: 5,
      langs: { id: { words: 3 }, en: { words: 3 } }, // "kopi" is in both lists
    });
  });
});