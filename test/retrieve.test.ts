import { afterEach, describe, expect, it, vi } from "vitest";
import { hidden } from "../src/base";
import { hear, reply } from "../src/brain";
import { admitting, linesFirst, openRetriever, packRetrieval, tidy, useRetriever } from "../src/retrieve";
import { makeLexicon } from "../src/words";
import { testSql } from "./sql";

// In the Worker, wrangler loads pet.wasm. In tests, Node loads the same compiled C++.
vi.mock("../src/wasm", async () => {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(new URL("../src/pet.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  return { math: instance.exports };
});

const LINES = [
  ["aku lapar", "makan dulu sana"],
  ["kamu lapar", "belum batreku minta dicas"],
  ["kopi atau teh", "aku gak minum"],
  ["nama aku", "senang kenalan"],
].map(([p, r]) => ({ prompt: tidy(p.split(" ")), reply: r.split(" ") }));
const ohm = linesFirst(openRetriever(packRetrieval(LINES), { minWords: 1 }), admitting([["aku", "belum", "ngerti"]]));
const own = (message: string) => ohm.own!(message.split(" "), () => 0)?.words.join(" ");
const visitor = (n: number) => ({ id: `visitor-${n}`, name: `V${n}`, ipHash: n.toString(16).padStart(16, "0") });
const T0 = Date.UTC(2026, 10, 1);
const HOUR = 3_600_000;

afterEach(() => {
  hidden.clear();
  useRetriever(null);
});

describe("his own lines", () => {
  it("matches without filler, with spellings fixed and names left out", () => {
    expect(tidy(["sumpah", "capek", "bangett"])).toEqual(["capek"]);
    expect(tidy(["ohm", "tinggal", "dimana"])).toEqual(["tinggal", "di", "mana"]);
    expect(tidy(["nama", "aku", "iqbal"])).toEqual(["nama", "aku"]);
    expect(tidy(["ih"])).toEqual(["ih"]); // nothing but filler: kept as it is
  });

  it("answers the person the message is about", () => {
    expect(own("kamu lapar")).toBe("belum batreku minta dicas");
    expect(own("aku lapar")).toBe("makan dulu sana");
  });

  it("doesn't let one word set off a longer line", () => {
    expect(own("kopi")).toBeUndefined();
    expect(own("kopi atau teh")).toBe("aku gak minum");
  });

  it("matches an introduction whatever the name", () => {
    expect(own("nama aku iqbal")).toBe("senang kenalan");
  });

  it("admits he doesn't know when no line fits", () => {
    expect(own("zzz")).toBeUndefined();
    expect(ohm.find(["zzz"], () => 0)).toMatchObject({ words: ["aku", "belum", "ngerti"], admit: true });
  });

  it("never says a blocked word, from a line or when admitting", () => {
    hidden.add("dicas");
    expect(own("kamu lapar")).toBeUndefined();
    hidden.add("ngerti");
    expect(ohm.find(["zzz"], () => 0)).toBeUndefined();
  });
});

describe("lessons and lines", () => {
  const lexicon = makeLexicon({ id: "kopi\natau\nteh\nenak\nsekali\naku\ngak\nminum", en: "" }, "badword");
  const teach = (sql: SqlStorage, people: number) => {
    for (let n = 1; n <= people; n++) hear(sql, lexicon, ["kopi", "enak", "sekali"], visitor(n), T0 + n * HOUR, []);
  };

  it("admits, not the chain, before 3 people have taught the same thing", () => {
    const sql = testSql();
    useRetriever(ohm);
    teach(sql, 1);
    expect(reply(sql, ["kopi"], [], () => 0.5)?.why.retrieved?.admit).toBe(true);
  });

  it("lets a lesson speak once 3 people taught it, unless his line mentions that word", () => {
    const sql = testSql();
    useRetriever(ohm);
    teach(sql, 3);
    const taught = reply(sql, ["kopi"], [], () => 0.5)!;
    expect(taught.why.seed.from).not.toBe("retrieved");
    expect(taught.words).toContain("enak");
    expect(reply(sql, ["kopi", "atau", "teh"], [], () => 0.5)?.why.retrieved?.own).toBe(true);
  });
});
