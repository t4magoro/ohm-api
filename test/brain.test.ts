import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerTo } from "../src/answers";
import { brainStats, follow, hear, inStyle, reply } from "../src/brain";
import { g2 } from "../src/grounding";
import { markRated } from "../src/history";
import { rate, skills } from "../src/mind";
import { blockWord } from "../src/moderation";
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
const HOUR = 3_600_000;
const DRY: Situation[] = ["siang"];
const RAIN: Situation[] = ["siang", "rain"];
// A tiny lexicon: "badword" stands in for a real blocked word.
const lexicon = makeLexicon({ id: "aku\nsuka\nkopi\nhujan\nteh\ntidak\ngak\napa\nkabar\nbaik\nmakan\nnasi\nlagi", en: "i\nlike\ncoffee\nkopi" }, "badword");

let sql: SqlStorage;
let now = T0;
beforeEach(() => {
  sql = testSql();
  now = T0;
});
// Each message an hour after the last: a word is sighted at most once per clock hour (that rule has its own test).
const say = (text: string, who = RINA, on = DRY) => hear(sql, lexicon, text.split(" "), who, (now += HOUR), on);

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
    expect(skills(sql)).toEqual({ words: 0, guessing: 0, context: 0, expression: 0, conversation: 0 });
    say("aku suka kopi", BUDI); // aku, suka known (hit, hit), kopi new (miss);
    expect(skills(sql).words).toBeCloseTo(0.019701);
  });

  it("guesses each next word before learning it", () => {
    say("aku suka kopi"); // nothing known yet: nothing to guess
    say("aku suka", BUDI); // "aku" first, then "suka": right; then he guessed "kopi", not the end: wrong
    expect(skills(sql).guessing).toBeCloseTo(0.019701);
  });
});

describe("reply", () => {
  it("says nothing before Ohm knows any word", () => {
    expect(reply(sql, ["halo"], DRY)).toBeNull();
  });

  it("learns a sentence from one visitor, with a quarter vote", () => {
    for (let i = 0; i < 5; i++) say("aku suka kopi"); // Rina 5 times: still one visitor, every count is 1
    const { text, why } = reply(sql, ["aku"], DRY, () => 0)!;
    expect(text).toBe("aku suka kopi");
    expect(why.steps[0].tried[0].chance).toBe(0.25); // (1 − ¾) / 1
  });

  it("trusts a pattern more once two visitors typed it", () => {
    say("aku suka kopi");
    say("aku suka kopi", BUDI);
    expect(reply(sql, ["aku"], DRY, () => 0)!.why.steps[0].tried[0].chance).toBe(0.625); // (2 − ¾) / 2: five times one visitor's quarter
  });

  it("gives one visitor's word a quarter vote, even after a well-known start", () => {
    const afterAkuSuka = [
      { next: "kopi", count: 2 }, // Rina and Budi: 1¼ votes
      { next: "teh", count: 1 }, // Citra: ¼ vote
    ];
    // 3 votes for 2 next words: each gives up ¾, so he follows (3 − 1½) / 3 = ½ of the time
    const kopi = { votes: 3, options: 2, chance: 0.5, roll: 0, followed: true, word: "kopi", picked: 2, pickAt: 0, share: 5 / 6 };
    expect(follow(afterAkuSuka, () => 0)).toEqual(kopi);
    const rolls = [0.1, 0.9]; // follow (0.1 < ½), then pick at 0.9: past kopi's 5 of 6, 0.4 of the way into teh's 1
    const teh = follow(afterAkuSuka, () => rolls.shift()!);
    expect(teh).toMatchObject({ chance: 0.5, roll: 0.1, followed: true, word: "teh", picked: 1, share: 1 / 6 });
    expect(teh.pickAt).toBeCloseTo(0.4);
    expect(follow(afterAkuSuka, () => 0.7)).toEqual({ votes: 3, options: 2, chance: 0.5, roll: 0.7, followed: false }); // 1 time in 2 Ohm backs off
    const always = follow(afterAkuSuka, () => 0.7, true); // talking from evidence: no dice, the 0.7 is the pick
    expect(always).toMatchObject({ chance: 1, followed: true, word: "kopi", share: 5 / 6 });
    expect(always.roll).toBeUndefined();
    expect(follow([], () => 0)).toEqual({ votes: 0, options: 0, chance: 0, followed: false }); // nothing taught: babble
  });

  it("counts one visitor's pair once, however many words came before it", () => {
    say("aku kopi suka");
    say("hujan kopi suka"); // Rina typed "kopi suka" twice, after different words: still one visitor
    expect(count(sql, "SELECT count AS n FROM pairs WHERE p1 = 'kopi' AND next = 'suka'")).toBe(1);
    // Someone continued "kopi", so Ohm follows it: he only babbles after a word nobody continued.
    expect(reply(sql, ["kopi"], DRY, () => 0)!.why.steps[0].tried[1]).toEqual({ rung: "word", votes: 1, options: 1, chance: 1, followed: true });
  });

  it("counts a pair twice once two visitors typed it, even after different words", () => {
    say("aku kopi suka");
    say("hujan kopi suka", BUDI); // no triple has 2 visitors, but the pair "kopi suka" does
    expect(count(sql, "SELECT count AS n FROM pairs WHERE p1 = 'kopi' AND next = 'suka'")).toBe(2);
  });

  it("counts how often Ohm said each word", () => {
    say("kopi");
    reply(sql, ["kopi"], DRY, () => 0);
    expect(sql.exec("SELECT said FROM words WHERE word = 'kopi'").one()).toEqual({ said: 1 });
  });
});

describe("style", () => {
  it("stores a word once, and says it the way most people type it", () => {
    say("aku gak suka", RINA);
    say("aku gak suka", BUDI); // two people write "gak"
    say("aku tidak suka", CITRA); // one writes "tidak"
    expect(sql.exec("SELECT word FROM words WHERE word IN ('gak', 'tidak')").toArray()).toEqual([{ word: "tidak" }]);
    const { text, why } = inStyle(sql, lexicon, reply(sql, ["aku"], DRY, () => 0)!);
    expect(text).toBe("aku gak suka");
    expect(why.steps[0].word).toBe("gak");
  });

  it("counts one person's spelling once, however often they type it", () => {
    for (let i = 0; i < 5; i++) say("aku gak suka", RINA);
    say("aku tidak suka", BUDI);
    say("aku tidak suka", CITRA); // two people write "tidak", one writes "gak" five times
    expect(inStyle(sql, lexicon, reply(sql, ["aku"], DRY, () => 0)!).text).toBe("aku tidak suka");
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
      words: ["aku", "suka", "kopi"],
      why: {
        on: DRY,
        seed: { word: "aku", from: "topic" },
        steps: [
          { word: "suka", tried: [{ rung: "pair", votes: 3, options: 1, chance: 0.75, roll: 0, followed: true }], picked: 3, pickAt: 0, share: 1 },
          // 3 votes for 2 words: kopi has 2 − ¾ of the 3 − 1½ kept, teh has the other 1/6
          { word: "kopi", tried: [{ rung: "pair", votes: 3, options: 2, chance: 0.5, roll: 0, followed: true }], picked: 2, pickAt: 0, share: 5 / 6 },
          { word: "</s>", tried: [{ rung: "pair", votes: 2, options: 1, chance: 0.625, roll: 0, followed: true }], picked: 2, pickAt: 0, share: 1 },
        ],
        // Then to the left of "aku": all 3 started a sentence with "aku suka", so a sentence starts here
        back: [{ word: "<s>", tried: [{ rung: "pair", votes: 3, options: 1, chance: 0.75, roll: 0, followed: true }], picked: 3, pickAt: 0, share: 1 }],
      },
    });
  });
  
  it("grows a reply to the left, the way people start sentences", () => {
    say("aku suka kopi");
    say("aku suka kopi", BUDI);
    expect(count(sql, "SELECT count AS n FROM pairs WHERE p1 = '<s>' AND next = 'aku'")).toBe(2); // sentences start with "aku"
    const { text, why } = reply(sql, ["kopi"], DRY, () => 0)!; // nobody starts with "kopi", so he stops after it
    expect(text).toBe("aku suka kopi"); // and then grows left: suka before "kopi", aku before "suka kopi", then <s>
    expect(why.back!.map((s) => s.word)).toEqual(["suka", "aku", "<s>"]);
    expect(why.back![0].tried[0]).toEqual({ rung: "pair", votes: 2, options: 1, chance: 0.625, roll: 0, followed: true });
  });

  it("gives one visitor's word a quarter vote, however often they repeat it", () => {
    example();
    for (let i = 0; i < 30; i++) say("aku suka teh", CITRA); // the visitor rule: still one visitor
    const rolls = [0, 0, 0, 0.9]; // follow, pick suka, follow, then pick at 0.9: past kopi's 5 of 6
    const { steps } = reply(sql, ["aku"], DRY, () => rolls.shift() ?? 0)!.why;
    expect(steps[1]).toMatchObject({ word: "teh", tried: [{ rung: "pair", chance: 0.5, roll: 0, followed: true }], picked: 1, share: 1 / 6 });
    expect(steps[1].pickAt).toBeCloseTo(0.4); // the pick die landed 0.4 of the way into teh's part
  });

  it("shows babble: nothing taught after a word, and the chance to stop", () => {
    for (let i = 0; i < 5; i++) say("aku suka kopi"); // 15 words heard, 5 sentence ends
    sql.exec("INSERT INTO words (word, langs, uses) VALUES ('hujan', 'id', 0)"); // approved on the admin page: no patterns yet
    expect(reply(sql, ["hujan"], DRY, () => 0)!.why.steps).toEqual([
      {
        word: "</s>",
        tried: [
          { rung: "pair", votes: 0, options: 0, chance: 0, followed: false },
          { rung: "word", votes: 0, options: 0, chance: 0, followed: false },
        ],
        stop: 0.25, // 5 sentence ends among 15 words + 5 ends
        ends: 5,
        heard: 20,
        stopRoll: 0,
      },
    ]);
  });
});

describe("answers", () => {
  // Ohm said `line` to `who`, and they wrote `text` back within 2 minutes.
  const answer = (line: string, text: string, who = RINA) => hear(sql, lexicon, text.split(" "), who, T0, DRY, line.split(" "));
  // Ohm asks "kabar" and hears "baik", asks "makan" and hears "nasi", 8 times each, from people taking turns.
  const chats = (people = [RINA, BUDI]) => {
    say("kabar baik makan nasi", CITRA); // Ohm knows the words
    for (let i = 0; i < 8; i++) {
      answer("kabar", "baik", people[i % people.length]);
      answer("makan", "nasi", people[i % people.length]);
    }
  };

  it("learns what people answer, once two of them did and it's no coincidence", () => {
    chats();
    expect(sql.exec("SELECT cue, answer FROM cues ORDER BY cue").toArray()).toEqual([
      { cue: "kabar", answer: "baik" }, // G² 20.7
      { cue: "makan", answer: "nasi" },
    ]);
  });

  it("one person can't teach him an answer, however often they give it", () => {
    chats([RINA]);
    expect(count(sql, "SELECT COUNT(*) AS n FROM cues WHERE answer IS NOT NULL")).toBe(0);
  });

  it("answers your cue with a whole answer people gave", () => {
    chats();
    const { text, why } = reply(sql, ["kabar"], DRY, () => 0)!;
    expect(text).toBe("baik");
    expect(why.seed).toMatchObject({ word: "baik", from: "answer", cue: "kabar" });
    // 8 of the 8 "kabar" exchanges were answered "baik", against 8 of all 16: lift 2, from the counts as they are now
    expect(why.seed).toMatchObject({ counts: { n: 8, of: 8, all: 8, total: 16 }, lift: 2 });
    expect(why.quote).toEqual({ words: ["baik"], times: 8 });
  });

  it("keeps only answers he could say, and starts from the answer word when none fits", () => {
    chats();
    sql.exec("DELETE FROM answers");
    answer("kabar", "baik xyzzy"); // xyzzy waits for approval: the answer isn't kept
    expect(count(sql, "SELECT COUNT(*) AS n FROM answers")).toBe(0);
    const { text, why } = reply(sql, ["kabar"], DRY, () => 0)!;
    expect(text.split(" ")[0]).toBe("baik");
    expect(why.quote).toBeUndefined();
  });

  it("the most specific cue wins: a pair he knows overrules its single words", () => {
    say("apa kabar baik makan nasi lagi", CITRA);
    for (let i = 0; i < 10; i++) {
      answer("apa kabar", "baik", [RINA, BUDI][i % 2]);
      answer("makan", "nasi", [RINA, BUDI][i % 2]);
    }
    answer("lagi apa", "makan"); // a new question, no answer yet
    expect(reply(sql, ["apa"], DRY, () => 0)!.why.seed).toMatchObject({ word: "baik", cue: "apa" });
    expect(reply(sql, ["lagi", "apa"], DRY, () => 0)!.why.seed.from).toBe("topic"); // not "baik"
  });

  it("asks back sometimes, when he has no answer and you didn't ask him anything", () => {
    say("apa kabar"); // people ask him "apa"
    expect(reply(sql, ["kopi"], DRY, () => 0)!.why.seed).toEqual({ word: "apa", from: "ask" });
    expect(reply(sql, ["kopi"], DRY, () => 0.5)!.why.seed.from).toBe("random"); // 3 times in 4 he doesn't
    expect(reply(sql, ["apa"], DRY, () => 0)!.why.seed.from).toBe("topic"); // you asked him something
  });

  it("measures conversation: when he had an answer ready for his line, did you give it?", () => {
    chats();
    expect(skills(sql).conversation).toBe(0); // the links only formed with the last exchanges
    answer("kabar", "baik", RINA); // he had "baik" ready for "kabar": a hit
    expect(skills(sql).conversation).toBeCloseTo(0.01);
    answer("kabar", "nasi", CITRA); // a miss
    expect(skills(sql).conversation).toBeCloseTo(0.0099);
    answer("hujan", "baik", RINA); // no answer ready for "hujan": not a test
    expect(skills(sql).conversation).toBeCloseTo(0.0099);
  });

  it("forgets an answer when you block one of its words", () => {
    chats();
    blockWord(sql, "baik");
    expect(answerTo(sql, ["kabar"])).toBeUndefined();
    expect(count(sql, "SELECT COUNT(*) AS n FROM answers WHERE cue = 'kabar'")).toBe(0);
  });

  it("says a quoted answer the way most people type it", () => {
    say("kabar tidak gak makan baik");
    for (let i = 0; i < 8; i++) {
      answer("kabar", "gak", [RINA, BUDI][i % 2]);
      answer("makan", "baik", [RINA, BUDI][i % 2]);
    }
    const said = inStyle(sql, lexicon, reply(sql, ["kabar"], DRY, () => 0)!);
    expect(said.text).toBe("gak");
    expect(said.why.quote!.words).toEqual(["gak"]);
    expect(said.words).toEqual(["tidak"]); // stored spelling, for his next exchange
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

  it("counts a word once per clock hour, so a drill in one hour can't link it", () => {
    background();
    const drill = (who: typeof RINA, minute: number) => hear(sql, lexicon, ["hujan"], who, now + minute * 60_000, RAIN);
    drill(visitor(1), 1);
    drill(visitor(2), 30); // another friend, the same hour: no new sighting
    expect(sql.exec("SELECT seen FROM words WHERE word = 'hujan'").one()).toEqual({ seen: 1 });
    expect(count(sql, "SELECT COUNT(*) AS n FROM links")).toBe(0);
    drill(visitor(2), 61); // the next hour
    expect(sql.exec("SELECT word, situation FROM links").toArray()).toEqual([{ word: "hujan", situation: "rain" }]);
  });

  it("never links from a single sighting, however rare the situation", () => {
    for (let i = 10; i < 40; i++) say("aku suka kopi", visitor(i)); // 90 dry sightings
    say("hujan", visitor(1), RAIN); // alone, G² would be 11.0: past 10.83
    expect(count(sql, "SELECT COUNT(*) AS n FROM links")).toBe(0);
  });

  it("friends on one Wi-Fi teach situations, and count as one visitor for sentences", () => {
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
    // 2 of hujan's 2 sightings were in the rain, against 2 of all 32 sightings: 16 times more likely
    expect(rainy.why.seed).toMatchObject({ counts: { n: 2, of: 2, all: 2, total: 32 }, lift: 16 });
    expect(rainy.why.seed.roll).toBeUndefined(); // no topic to choose from
    expect(reply(sql, ["xyz"], DRY, () => 0)!.why.seed).toEqual({ word: "aku", from: "random" }); // no dry-weather word
  });

  it("rolls a die between his situation and your topic", () => {
    background();
    say("hujan", visitor(1), RAIN);
    say("hujan", visitor(2), RAIN);
    expect(reply(sql, ["kopi"], RAIN, () => 0.1)!.why.seed).toMatchObject({ word: "hujan", from: "situation", roll: 0.1 });
    expect(reply(sql, ["kopi"], RAIN, () => 0.5)!.why.seed).toEqual({ word: "kopi", from: "topic", roll: 0.5 }); // 0.5 isn't below 0.3
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

  it("a mind saved before a skill existed starts it at 0", () => {
    const old = { skills: { words: 0.5, context: 0.5, expression: 0.5 }, tokens: 1, ends: 1, sightings: 0, seenIn: {} };
    sql.exec("INSERT INTO kv (key, value) VALUES ('mind', ?)", JSON.stringify(old));
    expect(skills(sql)).toEqual({ ...old.skills, guessing: 0, conversation: 0 });
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