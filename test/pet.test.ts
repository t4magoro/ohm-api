import { describe, expect, it, vi } from "vitest";
import { act, catchUp, newPet } from "../src/pet";

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

describe("pet rules", () => {
  it("starts full and on", () => {
    const pet = newPet(T0);
    expect(pet.status).toBe("on");
    expect(pet.charge).toEqual({ v: 100, at: T0, rate: 5 });
  });

  it("shuts down exactly when charge hits 0, even if nobody was watching", () => {
    const pet = newPet(T0);
    expect(catchUp(pet, T0 + 19 * HOUR)).toBe(false);
    expect(catchUp(pet, T0 + 30 * HOUR)).toBe(true);
    expect(pet.status).toBe("off");
    expect(pet.offAt).toBe(T0 + 20 * HOUR);
    expect(pet.recordMs).toBe(20 * HOUR);
    expect(catchUp(pet, T0 + 31 * HOUR)).toBe(false); // only shuts down once
  });

  it("charges +15 but never above 100", () => {
    const pet = newPet(T0);
    expect(act(pet, "charge", T0 + 4 * HOUR)).toBeNull(); // 80 + 15
    expect(pet.charge.v).toBe(95);
    act(pet, "charge", T0 + 4 * HOUR);
    expect(pet.charge.v).toBe(100);
  });

  it("can't be charged while off, and a reboot starts a new life", () => {
    const pet = newPet(T0);
    catchUp(pet, T0 + 30 * HOUR);
    expect(act(pet, "charge", T0 + 30 * HOUR)).toMatch(/off/);
    expect(act(pet, "reboot", T0 + 30 * HOUR)).toBeNull();
    expect(pet).toMatchObject({ status: "on", life: 2, bornAt: T0 + 30 * HOUR, offAt: null });
    expect(pet.charge.v).toBe(30);
    expect(act(pet, "reboot", T0 + 30 * HOUR)).toMatch(/already on/);
  });
});