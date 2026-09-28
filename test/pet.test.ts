import { describe, expect, it, vi } from "vitest";
import { act, applyWeather, catchUp, newPet } from "../src/pet";

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
const DAY = { tempC: 27, raining: false, isDay: true };
const NIGHT = { tempC: 22, raining: false, isDay: false };

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

describe("weather", () => {
  it("night halves the drain without making the bars jump", () => {
    const pet = newPet(T0, DAY);
    applyWeather(pet, NIGHT, T0 + 4 * HOUR); // charge is 80 at this moment
    expect(pet.charge).toEqual({ v: 80, at: T0 + 4 * HOUR, rate: 2.5 });
    expect(pet.mood.rate).toBe(4);
  });

  it("heat drains the battery faster and rain drains the mood faster", () => {
    const pet = newPet(T0, DAY);
    applyWeather(pet, { tempC: 33, raining: true, isDay: true }, T0);
    expect(pet.charge.rate).toBe(7.5);
    expect(pet.mood.rate).toBe(10.4);
  });

  it("an Ohm that's off ignores the weather", () => {
    const pet = newPet(T0, DAY);
    catchUp(pet, T0 + 30 * HOUR);
    applyWeather(pet, NIGHT, T0 + 30 * HOUR);
    expect(pet.charge.rate).toBe(0);
  });

  it("a reboot uses the current weather's speed", () => {
    const pet = newPet(T0, DAY);
    catchUp(pet, T0 + 30 * HOUR);
    act(pet, "reboot", T0 + 30 * HOUR, NIGHT);
    expect(pet.charge.rate).toBe(2.5);
  });
});