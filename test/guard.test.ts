import { describe, expect, it } from "vitest";
import { cooldown, hashIp, parseClientMessage } from "../src/guard";
import { cleanName } from "../src/protocol";

describe("parseClientMessage", () => {
  it("accepts the known messages", () => {
    expect(parseClientMessage('{"t":"charge"}')).toEqual({ t: "charge" });
    expect(parseClientMessage('{"t":"hello","id":"abc12345","name":"  Rina  "}')).toEqual({
      t: "hello",
      id: "abc12345",
      name: "Rina",
    });
    expect(parseClientMessage('{"t":"say","text":"aku suka kopi"}')).toEqual({ t: "say", text: "aku suka kopi" });
    expect(parseClientMessage('{"t":"report","lineId":7}')).toEqual({ t: "report", lineId: 7 });
  });

  it("keeps a valid lastSeen and drops a broken one without refusing the hello", () => {
    const hello = { t: "hello", id: "abc12345", name: "Rina" };
    expect(parseClientMessage(JSON.stringify({ ...hello, lastSeen: 1790600000000 }))).toEqual({ ...hello, lastSeen: 1790600000000 });
    for (const lastSeen of ["yesterday", -5, 1.5, null]) {
      expect(parseClientMessage(JSON.stringify({ ...hello, lastSeen }))).toEqual(hello);
    }
  });

  it("rejects junk", () => {
    const junk = [
      "not json",
      "null",
      "[]",
      '{"t":"explode"}',
      '{"t":"hello","id":"x","name":"Rina"}',
      '{"t":"say","text":"   "}',
      JSON.stringify({ t: "say", text: "a".repeat(201) }),
      '{"t":"report","lineId":"7"}',
      '{"t":"report","lineId":-1}',
      "x".repeat(2000),
    ];
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

describe("hashIp", () => {
  it("gives 16 hex characters that depend on the secret salt", async () => {
    const a = await hashIp("1.2.3.4", "salt-one");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await hashIp("1.2.3.4", "salt-one")).toBe(a); // same IP, same hash: bans keep working
    expect(await hashIp("1.2.3.4", "salt-two")).not.toBe(a);
    expect(await hashIp("5.6.7.8", "salt-one")).not.toBe(a);
  });
});