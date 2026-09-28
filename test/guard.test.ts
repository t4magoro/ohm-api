import { describe, expect, it } from "vitest";
import { cooldown, parseClientMessage } from "../src/guard";
import { cleanName } from "../src/protocol";

describe("parseClientMessage", () => {
  it("accepts the known messages", () => {
    expect(parseClientMessage('{"t":"charge"}')).toEqual({ t: "charge" });
    expect(parseClientMessage('{"t":"hello","id":"abc12345","name":"  Rina  "}')).toEqual({
      t: "hello",
      id: "abc12345",
      name: "Rina",
    });
  });

  it("rejects junk", () => {
    const junk = ["not json", "null", "[]", '{"t":"explode"}', '{"t":"hello","id":"x","name":"Rina"}', "x".repeat(2000)];
    for (const raw of junk) expect(parseClientMessage(raw)).toBeNull();
    expect(parseClientMessage(new ArrayBuffer(8))).toBeNull();
  });
});

describe("cleanName", () => {
  it("allows normal names and tidies spaces", () => {
    expect(cleanName("Budi   Santoso")).toBe("Budi Santoso");
    expect(cleanName("Élodie_99")).toBe("Élodie_99");
  });

  it("rejects too short, too long and HTML", () => {
    for (const bad of ["R", "a".repeat(17), "<img src=x>", "   "]) expect(cleanName(bad)).toBeNull();
  });
});

describe("cooldown", () => {
  it("allows one action per gap for each IP", () => {
    const allow = cooldown(3_000);
    expect(allow("1.2.3.4", 0)).toBe(true);
    expect(allow("1.2.3.4", 2_999)).toBe(false);
    expect(allow("5.6.7.8", 2_999)).toBe(true); // other visitors aren't affected
    expect(allow("1.2.3.4", 3_000)).toBe(true);
  });
});