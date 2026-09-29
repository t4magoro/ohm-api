import { describe, expect, it, vi } from "vitest";
import { act, applyConditions, catchUp, isSulking, newPet } from "../src/pet";
import { DEFAULT_SETTINGS } from "../src/protocol";

// In the Worker, wrangler loads pet.wasm. In tests, Node loads the same compiled C++.
// Run `npm run build:wasm` first (`npm test` does it for you).
vi.mock("../src/wasm", async () => {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(new URL("../src/pet.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  return { math: instance.exports };
});

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 1); // any fixed start time
const DAY = { weather: { tempC: 27, raining: false, isDay: true }, settings: DEFAULT_SETTINGS };
const NIGHT = { weather: { tempC: 22, raining: false, isDay: false }, settings: DEFAULT_SETTINGS };

describe("pet rules", () => {
  it("starts full and on", () => {
    const pet = newPet(T0, DAY);
    expect(pet.status).toBe("on");
    expect(pet.charge).toEqual({ v: 100, at: T0, rate: 5 });
  });

  it("shuts down exactly when charge hits 0, even if nobody was watching", () => {
    const pet = newPet(T0, DAY);
    expect(catchUp(pet, T0 + 19 * HOUR)).toBe(false);
    expect(catchUp(pet, T0 + 30 * HOUR)).toBe(true);
    expect(pet.status).toBe("off");
    expect(pet.offAt).toBe(T0 + 20 * HOUR);
    expect(pet.recordMs).toBe(20 * HOUR);
    expect(catchUp(pet, T0 + 31 * HOUR)).toBe(false); // only shuts down once
  });

  it("charges +15 but never above 100", () => {
    const pet = newPet(T0, DAY);
    expect(act(pet, "charge", T0 + 4 * HOUR, DAY)).toBeNull(); // 80 + 15
    expect(pet.charge.v).toBe(95);
    act(pet, "charge", T0 + 4 * HOUR, DAY);
    expect(pet.charge.v).toBe(100);
    expect(pet.charge.v).toBe(100);
    expect(pet.charges).toBe(2); // counted for the jetpack milestone, even when the bar is ful
  });

  it("can't be charged while off, and a reboot starts a new life", () => {
    const pet = newPet(T0, DAY);
    catchUp(pet, T0 + 30 * HOUR);
    expect(act(pet, "charge", T0 + 30 * HOUR, DAY)).toMatch(/off/);
    expect(act(pet, "reboot", T0 + 30 * HOUR, DAY)).toBeNull();
    expect(pet).toMatchObject({ status: "on", life: 2, bornAt: T0 + 30 * HOUR, offAt: null });
    expect(pet.charge.v).toBe(30);
    expect(act(pet, "reboot", T0 + 30 * HOUR, DAY)).toMatch(/already on/);
  });
});

describe("conditions", () => {
  it("night halves the drain without making the bars jump", () => {
    const pet = newPet(T0, DAY);
    applyConditions(pet, NIGHT, T0 + 4 * HOUR); // charge is 80 at this moment
    expect(pet.charge).toEqual({ v: 80, at: T0 + 4 * HOUR, rate: 2.5 });
    expect(pet.mood.rate).toBe(4);
  });

  it("heat drains the battery faster and rain drains the mood faster", () => {
    const pet = newPet(T0, DAY);
    applyConditions(pet, { ...DAY, weather: { tempC: 33, raining: true, isDay: true } }, T0);
    expect(pet.charge.rate).toBe(7.5);
    expect(pet.mood.rate).toBe(10.4);
  });

  it("your battery settings change the speed, also for a living Ohm", () => {
    const pet = newPet(T0, DAY);
    applyConditions(pet, { ...DAY, settings: { chargeHours: 40, moodHours: 25 } }, T0 + 4 * HOUR);
    expect(pet.charge).toEqual({ v: 80, at: T0 + 4 * HOUR, rate: 2.5 }); // 100 / 40 h
    expect(pet.mood.rate).toBe(4); // 100 / 25 h
  });

  it("an Ohm that's off ignores the weather", () => {
    const pet = newPet(T0, DAY);
    catchUp(pet, T0 + 30 * HOUR);
    applyConditions(pet, NIGHT, T0 + 30 * HOUR);
    expect(pet.charge.rate).toBe(0);
  });

  it("a reboot uses the current speed", () => {
    const pet = newPet(T0, DAY);
    catchUp(pet, T0 + 30 * HOUR);
    act(pet, "reboot", T0 + 30 * HOUR, NIGHT);
    expect(pet.charge.rate).toBe(2.5);
  });
});

describe("chat", () => {
  it("talking cheers Ohm up a little", () => {
    const pet = newPet(T0, DAY);
    act(pet, "chat", T0 + 5 * HOUR, DAY); // mood 60 + 2
    expect(pet.mood.v).toBe(62);
  });

  it("at mood 0 Ohm sulks until someone plays with it", () => {
    const pet = newPet(T0, DAY);
    expect(isSulking(pet, T0 + 12 * HOUR)).toBe(false); // mood 4
    expect(isSulking(pet, T0 + 13 * HOUR)).toBe(true);
    act(pet, "play", T0 + 13 * HOUR, DAY);
    expect(isSulking(pet, T0 + 13 * HOUR)).toBe(false);
  });
});