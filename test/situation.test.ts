import { describe, expect, it, vi } from "vitest";
import { newPet } from "../src/pet";
import { DEFAULT_SETTINGS } from "../src/protocol";
import { partOfDay, situation } from "../src/situation";

vi.mock("../src/wasm", async () => {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(new URL("../src/pet.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  return { math: instance.exports };
});

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 1); // 07:00 in Bandung
const bandung = (hour: number) => T0 + (hour - 7) * HOUR;
const SUNNY = { tempC: 27, raining: false, isDay: true };

describe("partOfDay", () => {
  it("follows Bandung's clock", () => {
    expect([4, 5, 10, 11, 14, 15, 17, 18, 23].map((h) => partOfDay(bandung(h)))).toEqual([
      "malam", "pagi", "pagi", "siang", "siang", "sore", "sore", "malam", "malam",
    ]);
  });
});

describe("situation", () => {
  it("lists the weather, low bars and what you just did", () => {
    const pet = newPet(T0, { weather: SUNNY, settings: DEFAULT_SETTINGS });
    expect(situation(SUNNY, pet, T0)).toEqual(["pagi"]);
    expect(situation({ tempC: 31, raining: true, isDay: true }, pet, T0)).toEqual(["pagi", "rain", "hot"]);
    const tired = { ...pet, charge: { ...pet.charge, v: 49 }, mood: { ...pet.mood, v: 29 } };
    expect(situation(SUNNY, tired, T0)).toEqual(["pagi", "battery_low", "mood_low"]);
    expect(situation(SUNNY, pet, T0, { t: "charge", at: T0 - 59_000 })).toEqual(["pagi", "charge"]);
    expect(situation(SUNNY, pet, T0, { t: "charge", at: T0 - 61_000 })).toEqual(["pagi"]); // too long ago
  });
});