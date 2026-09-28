import { describe, expect, it } from "vitest";
import { makeLexicon } from "../src/words";

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