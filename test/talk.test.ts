import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBase, useBase } from "../src/base";
import { forOthers, hear, reply } from "../src/brain";
import { rng } from "../src/gen";
import { blockWord } from "../src/moderation";
import type { Pet } from "../src/protocol";
import { ADMIT } from "../src/retrieve";
import { stateTokens } from "../src/situation";
import { CRISIS, loadModel, SETTINGS, useModel, type Model } from "../src/talk";
import { makeLexicon, tokenize } from "../src/words";
import { testSql } from "./sql";

vi.mock("../src/wasm", async () => {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(new URL("../src/pet.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  return { math: instance.exports };
});

// The real files the Worker loads: word lists, Tatoeba counts, and G (the round 1+2 model for test seed 1000).
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url));
const bytes = (f: string) => { const b = read(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const lexicon = makeLexicon({ id: read("wordlists/id.txt").toString(), en: read("wordlists/en.txt").toString() }, read("wordlists/block.txt").toString());
const meta = JSON.parse(read("src/model.json").toString());
let model: Model;
beforeAll(() => {
  useBase(loadBase(bytes("src/base.bin")));
  model = loadModel(bytes("src/model.bin"), meta, lexicon, new WebAssembly.Module(read("src/kern.wasm")));
  useModel(model);
});

const visitor = (n: number) => ({ id: `visitor-${n}`, name: `V${n}`, ipHash: n.toString(16).padStart(16, "0") });
const HOUR = 3_600_000;
const talk = { state: ["penuh", "senang", "cerah", "siang"], prev: [] };
const saved = { ...SETTINGS };
let sql: SqlStorage;
let now = Date.UTC(2026, 9, 1);
beforeEach(() => (sql = testSql()));
afterEach(() => Object.assign(SETTINGS, saved));
const ask = (text: string, seed = 1) => reply(sql, lexicon.normalize(tokenize(text)), ["siang"], rng(seed), talk)!;
const say = (text: string, who: number) => hear(sql, lexicon, tokenize(text), visitor(who), (now += HOUR), ["siang"]);

describe("brain v4", () => {
  it("keeps its copy of the crisis reply equal to line group 88", () => {
    expect(JSON.parse(read("lines/ohm.json").toString())[88]).toEqual({ p: CRISIS.p, r: [CRISIS.r] });
  });

  it("says the fixed crisis reply before G runs", () => {
    for (const p of CRISIS.p) expect(ask(p).text).toBe(CRISIS.r);
  });

  it("writes a reply word by word, from words he may say", () => {
    const canSay = new Set(meta.canSay);
    for (let seed = 1; seed <= 5; seed++) {
      const r = ask("halo ohm apa kabar", seed);
      const w = r.why.written!;
      expect(r.why.seed.from).toBe("written");
      expect(w.candidates).toHaveLength(SETTINGS.k);
      expect(r.words.every((x) => canSay.has(x))).toBe(true);
      expect(w.steps.map((s) => s.word)).toEqual([...r.words, "<end>"]);
      expect(w.steps.every((s) => s.p > 0 && s.p <= 1 && s.top.length > 0 && s.lesson === 0)).toBe(true);
      expect(w.read).toEqual(["halo", "ohm", "apa", "kabar"]);
      expect(w.state).toEqual(talk.state);
      for (const s of w.steps) { // attention on each message word, a share of all he looked at
        expect(s.attn).toHaveLength(4);
        expect(s.attn!.every((x) => x >= 0) && s.attn!.reduce((a, x) => a + x, 0) <= 1.001).toBe(true);
      }
    }
  });

  it("shows your message and where he looked only to you", () => {
    const why = ask("aku suka kopi panas").why, other = forOthers(why).written!;
    expect(why.written!.read).toEqual(["aku", "suka", "kopi", "panas"]);
    expect(other.read).toEqual([]);
    expect(other.steps.every((s) => s.attn === undefined && s.top.length > 0)).toBe(true);
    expect(JSON.stringify(other)).not.toContain("kopi panas");
    expect({ ...other, read: why.written!.read }).toMatchObject({ ...why.written!, steps: other.steps });
  });

  it("never says a word an admin blocked, in any candidate", () => {
    const first = ask("halo ohm apa kabar").words[0];
    blockWord(sql, first);
    for (let seed = 1; seed <= 10; seed++) {
      for (const c of ask("halo ohm apa kabar", seed).why.written!.candidates) expect(c.words ?? []).not.toContain(first);
    }
  });

  it("says the best banned copy when every candidate is one, and never when one isn't (change 15)", () => {
    const first = ask("nama kamu siapa", 3).why.written!.candidates.filter((c) => c.words).map((c) => c.words!.join(" "));
    const added = first.filter((t) => !model.copies.has(t));
    added.forEach((t) => model.copies.add(t)); // the same dice give the same candidates, now all banned
    try {
      const w = ask("nama kamu siapa", 3).why.written!;
      const done = w.candidates.filter((c) => c.words);
      expect(done.every((c) => c.why === "copy")).toBe(true);
      expect(w.admit).toBe(false);
      expect(w.score).toBe(Math.max(...done.map((c) => c.score)));
      model.copies.delete(first[0]); // one candidate is fresh again: it must win over every copy
      const again = ask("nama kamu siapa", 3).why.written!;
      expect(again.candidates[again.chosen].why).toBe("ok");
    } finally {
      added.forEach((t) => model.copies.delete(t));
      if (!added.includes(first[0])) model.copies.add(first[0]); // it was a real banned copy: put it back
    }
  });

  it("admits he doesn't know when the guard fails", () => {
    SETTINGS.theta = 0.1; // log2 p is never above 0, so every candidate fails
    const r = ask("halo ohm apa kabar");
    expect(r.why.written!.admit).toBe(true);
    expect(ADMIT.map((a) => a.join(" "))).toContain(r.text);
  });

  it("says back what 3 visitors taught, through the lesson mix", () => {
    SETTINGS.lessons = "all"; // "kopi" is in G's vocabulary, so "new" wouldn't mix it in; the mechanics stay tested
    for (const who of [1, 2, 3]) say("kopi enak sekali", who);
    SETTINGS.kappa = 0.1; // κ is tuned later; at 0.1, λ = 3 / 3.1 = 0.97 fills the top-p set (π = 0.95) at every step
    const r = ask("kopi");
    expect(r.why.lesson).toMatchObject({ word: "kopi", count: 3 });
    expect(r.why.written!.lambda).toBeCloseTo(3 / 3.1);
    expect(r.text).toBe("kopi enak sekali");
    expect(r.why.written!.steps.every((s) => s.lesson > 0.5)).toBe(true);
  });

  it("says a word G has never seen, outside his word lists, once 3 visitors teach it", () => {
    // A made-up word: in neither word list nor G's vocabulary ("durian" was, until round 2 put it in G's).
    expect(meta.itos).not.toContain("zorbul");
    expect(lexicon.langsOf("zorbul")).toEqual([]);
    for (const who of [1, 2, 3]) say("zorbul enak sekali", who);
    SETTINGS.kappa = 0.1;
    const r = ask("zorbul");
    expect(r.why.lesson).toMatchObject({ word: "zorbul", count: 3 });
    expect(r.text).toBe("zorbul enak sekali");
  });

  it("doesn't learn a lesson from one visitor alone", () => {
    SETTINGS.lessons = "all"; // the rule is checked on a known word, where only "all" mixes
    for (let i = 0; i < 3; i++) say("kopi enak sekali", 1);
    SETTINGS.kappa = 0.1;
    expect(ask("kopi").why.lesson).toBeUndefined();
  });

  it("weighs a lesson by how many people taught it, up to 5, so two friends taking turns count as 5 at most", () => {
    SETTINGS.lessons = "all"; // "kopi" is in G's vocabulary, so "new" wouldn't mix it in; the mechanics stay tested
    const weight = (people: number[]) => {
      sql = testSql();
      for (const who of people) say("kopi enak sekali", who);
      return ask("kopi").why.written!.lambda;
    };
    const [three, five, alternate] = [weight([1, 2, 3]), weight([1, 2, 3, 4, 5]), weight(Array.from({ length: 100 }, (_, i) => 1 + (i % 2)))];
    expect([three, five]).toEqual([3 / (3 + SETTINGS.kappa), 5 / (5 + SETTINGS.kappa)]);
    expect(alternate).toBe(five);
  });

  it("mixes in a lesson only on a word his network doesn't know, however many people taught a known one (change 16)", () => {
    expect(SETTINGS.lessons).toBe("new");
    for (const who of [1, 2, 3, 4, 5, 6]) {
      say("kopi enak sekali", who);
      say("zorbul enak sekali", who);
    }
    const known = ask("kopi");
    expect(known.why.lesson).toBeUndefined();
    expect(known.why.written!.lambda).toBe(0);
    expect(known.why.written!.steps.every((s) => s.lesson === 0)).toBe(true);
    expect(ask("zorbul").why.lesson).toMatchObject({ word: "zorbul", count: 6 });
    SETTINGS.lessons = "off"; // the hotfix's setting still works
    expect(ask("zorbul").why.lesson).toBeUndefined();
  });
});

describe("stateTokens", () => {
  const pet = (charge: number, mood: number) => ({ status: "on", charge: { v: charge, at: 0, rate: 0 }, mood: { v: mood, at: 0, rate: 0 } }) as Pet;
  const noon = Date.UTC(2026, 9, 1, 5); // 12:00 in Bandung
  it("puts his state in the teacher's words", () => {
    expect(stateTokens({ tempC: 25, raining: true, isDay: true }, pet(40, 90), noon)).toEqual(["tipis", "senang", "hujan", "siang"]);
    expect(stateTokens({ tempC: 32, raining: false, isDay: true }, pet(90, 50), noon)).toEqual(["penuh", "biasa", "panas", "siang"]);
    expect(stateTokens({ tempC: 18, raining: false, isDay: false }, pet(60, 10), noon)).toEqual(["setengah", "sedih", "dingin", "siang"]);
  });
});
