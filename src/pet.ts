// Ohm's rules. The math comes from C++ (pet.cpp); this file decides what happens.
import type { Pet, Stat } from "./protocol";
import { math } from "./wasm";

const MAX = 100;
const CHARGE_GAIN = 15;
const PLAY_GAIN = 10;
const REBOOT_LEVEL = 30;
// ponytail: fixed Bandung weather until Phase 2 fetches the real one.
const WEATHER = { tempC: 27, raining: false, isDay: true };

const rates = () => ({
  charge: math.charge_rate(WEATHER.tempC, WEATHER.isDay ? 1 : 0),
  mood: math.mood_rate(WEATHER.raining ? 1 : 0, WEATHER.isDay ? 1 : 0),
});

const valueNow = (s: Stat, now: number) => math.value_now(s.v, s.at, s.rate, now);

export function newPet(now: number): Pet {
  const r = rates();
  return {
    status: "on",
    charge: { v: MAX, at: now, rate: r.charge },
    mood: { v: MAX, at: now, rate: r.mood },
    bornAt: now,
    offAt: null,
    life: 1,
    recordMs: 0,
  };
}

/** Applies the drain up to `now`. Returns true if Ohm just shut down. */
export function catchUp(pet: Pet, now: number): boolean {
  if (pet.status === "off") return false;
  const offAt = math.empty_at(pet.charge.v, pet.charge.at, pet.charge.rate);
  if (now < offAt) return false;
  // Shut down at the exact moment charge hit 0, even if nobody was watching.
  pet.status = "off";
  pet.offAt = offAt;
  pet.charge = { v: 0, at: offAt, rate: 0 };
  pet.mood = { v: valueNow(pet.mood, offAt), at: offAt, rate: 0 };
  pet.recordMs = Math.max(pet.recordMs, offAt - pet.bornAt);
  return true;
}

/** Applies a visitor's action. Returns an error message, or null if it worked. */
export function act(pet: Pet, action: "charge" | "play" | "reboot", now: number): string | null {
  if (action === "reboot") {
    if (pet.status === "on") return "Ohm is already on";
    const r = rates();
    pet.status = "on";
    pet.charge = { v: REBOOT_LEVEL, at: now, rate: r.charge };
    pet.mood = { v: REBOOT_LEVEL, at: now, rate: r.mood };
    pet.bornAt = now;
    pet.offAt = null;
    pet.life += 1;
    return null;
  }
  if (pet.status === "off") return "Ohm is off. Reboot it first";
  const key = action === "charge" ? "charge" : "mood";
  const gain = action === "charge" ? CHARGE_GAIN : PLAY_GAIN;
  const s = pet[key];
  pet[key] = { v: Math.min(MAX, valueNow(s, now) + gain), at: now, rate: s.rate };
  return null;
}