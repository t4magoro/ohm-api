import { describe, expect, it } from "vitest";
import { hasBlocked, makeLexicon, tokenize } from "../src/words";
import { testSql } from "./sql";

describe("makeLexicon", () => {
  // Windows line endings and blank lines must not matter.
  const lexicon = makeLexicon({ id: "aku\r\nkopi\r\n\r\n", en: "coffee\nkopi\n" }, "badword\n");

  it("knows which languages a word belongs to", () => {
    expect(lexicon.langsOf("aku")).toEqual(["id"]);
    expect(lexicon.langsOf("kopi")).toEqual(["id", "en"]);
    expect(lexicon.langsOf("xyzzy")).toEqual([]);
  });

  it("knows blocked words", () => {
    expect(lexicon.isBlocked("badword")).toBe(true);
    expect(lexicon.isBlocked("kopi")).toBe(false);
  });
});

describe("tokenize", () => {
  it("lowercases and keeps only words", () => {
    expect(tokenize("Aku  SUKA kopi!!!")).toEqual(["aku", "suka", "kopi"]);
    expect(tokenize("kupu-kupu don't 🤖 --")).toEqual(["kupu-kupu", "don't"]);
    expect(tokenize("a ".repeat(25))).toHaveLength(20);
  });
});

describe("normalize", () => {
  // The word lists are sorted by use. Here "tidak" ranks above "gak", so Ohm says "tidak".
  const lexicon = makeLexicon({ id: "aku\ntidak\nbanget\ngak", en: "" }, "badword");

  it("folds chat spellings into the one that ranks highest", () => {
    expect(lexicon.normalize(["gak", "nggak", "bgt", "tidak"])).toEqual(["tidak", "tidak", "banget", "tidak"]);
    expect(makeLexicon({ id: "gak\ntidak", en: "" }, "").normalize(["tidak"])).toEqual(["gak"]); // whichever ranks higher
  });

  it("squashes stretched letters", () => {
    expect(lexicon.normalize(tokenize("IYAAA bangettt kopiii"))).toEqual(["iya", "banget", "kopi"]);
  });

  it("stretching a blocked word doesn't hide it", () => {
    expect(hasBlocked(testSql(), lexicon, lexicon.normalize(tokenize("badwordddd")))).toBe(true);
  });
});


describe("hasBlocked", () => {
  // "badword" stands in for a real blocked word.
  const lexicon = makeLexicon({ id: "aku", en: "" }, "badword");

  it("works on nicknames too", () => {
    const sql = testSql();
    expect(hasBlocked(sql, lexicon, tokenize("BadWord-99"))).toBe(true); // digits and dashes don't hide it
    expect(hasBlocked(sql, lexicon, tokenize("Rina_07"))).toBe(false);
  });
});
