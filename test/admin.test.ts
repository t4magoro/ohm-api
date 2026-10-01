import { describe, expect, it } from "vitest";
import { cleanQuery, parseAdminCommand } from "../src/admin";

describe("parseAdminCommand", () => {
  it("accepts well-formed commands", () => {
    expect(parseAdminCommand("approve", { word: "wkwk", lang: "id" })).toEqual({ do: "approve", word: "wkwk", lang: "id" });
    expect(parseAdminCommand("ban", { ipHash: "0123456789abcdef" })).toEqual({ do: "ban", ipHash: "0123456789abcdef" });
    expect(parseAdminCommand("settings", { chargeHours: 24, moodHours: 12.5 })).toEqual({
      do: "settings",
      settings: { chargeHours: 24, moodHours: 12.5 },
    });
    expect(parseAdminCommand("reset", { confirm: "RESET" })).toEqual({ do: "reset" });
    expect(parseAdminCommand("forget", { text: "lagi makan" })).toEqual({ do: "forget", text: "lagi makan" });
  });

  it("rejects anything else", () => {
    const bad: [string, unknown][] = [
      ["explode", {}],
      ["approve", { word: "wkwk", lang: "fr" }],
      ["block", { word: "two words" }],
      ["block", { word: "Kopi" }], // words are always lowercase
      ["ban", { ipHash: "1.2.3.4" }],
      ["dismiss", { id: -1 }],
      ["settings", { chargeHours: 0, moodHours: 12 }], // 0 hours would mean infinite speed
      ["settings", { chargeHours: 169, moodHours: 12 }],
      ["settings", { chargeHours: "24", moodHours: 12 }],
      ["settings", { chargeHours: Number.NaN, moodHours: 12 }],
      ["reset", {}], // a reset needs the confirmation word
      ["reset", { confirm: "reset" }],
      ["settings", null],
      ["forget", { text: "" }],
      ["forget", { text: "Lagi  makan!" }], // not how Ohm stores an answer
    ];
    for (const [action, body] of bad) expect(parseAdminCommand(action, body)).toBeNull();
  });
});

describe("cleanQuery", () => {
  it("tidies the search box and refuses empty or huge searches", () => {
    expect(cleanQuery("  KoPi ")).toBe("kopi");
    expect(cleanQuery("   ")).toBeNull();
    expect(cleanQuery(null)).toBeNull();
    expect(cleanQuery("x".repeat(33))).toBeNull();
  });
});
