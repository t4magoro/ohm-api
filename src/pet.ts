// Ohm's rules. The math comes from C++ (pet.cpp); this file decides what happens.
import type { Pet, Settings, Stat, Weather } from "./protocol";
import { math } from "./wasm";

const MAX = 100;
const GAIN = { charge: 15, play: 10, chat: 2 }; // chat: talking to Ohm cheers it up a little
const REBOOT_LEVEL = 30;

/** Everything that decides how fast Ohm drains: Bandung's weather and your battery settings. */
export type Conditions = { weather: Weather; settings: Settings };

/** Drain speeds for these conditions, from the C++. */
const rates = ({ weather: w, settings: s }: Conditions) => ({
  charge: math.charge_rate(s.chargeHours, w.tempC, w.isDay ? 1 : 0),
  mood: math.mood_rate(s.moodHours, w.raining ? 1 : 0, w.isDay ? 1 : 0),
});

const valueNow = (s: Stat, now: number) => math.value_now(s.v, s.at, s.rate, now);

/** Keeps the value reached so far, then drains at `rate` from `now` on. */
const checkpoint = (s: Stat, now: number, rate: number): Stat => ({ v: valueNow(s, now), at: now, rate });

export function newPet(now: number, c: Conditions): Pet {
  const r = rates(c);
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

/** At mood 0, Ohm sulks: it won't talk until someone plays with it. */
export const isSulking = (pet: Pet, now: number) => pet.status === "on" && valueNow(pet.mood, now) === 0;

/** Applies the drain up to `now`. Returns true if Ohm just shut down. */
export function catchUp(pet: Pet, now: number): boolean {
  if (pet.status === "off") return false;
  const offAt = math.empty_at(pet.charge.v, pet.charge.at, pet.charge.rate);
  if (now < offAt) return false;
  // Shut down at the exact moment charge hit 0, even if nobody was watching.
  pet.status = "off";
  pet.offAt = offAt;
  pet.charge = { v: 0, at: offAt, rate: 0 };
  pet.mood = checkpoint(pet.mood, offAt, 0);
  pet.recordMs = Math.max(pet.recordMs, offAt - pet.bornAt);
  return true;
}

/** The weather or your settings changed: both bars switch speed without jumping. Call catchUp first. */
export function applyConditions(pet: Pet, c: Conditions, now: number) {
  if (pet.status === "off") return; // an Ohm that's off doesn't drain
  const r = rates(c);
  pet.charge = checkpoint(pet.charge, now, r.charge);
  pet.mood = checkpoint(pet.mood, now, r.mood);
}

/** Applies an action. Returns an error message, or null if it worked. */
export function act(pet: Pet, action: "charge" | "play" | "chat" | "reboot", now: number, c: Conditions): string | null {
  if (action === "reboot") {
    if (pet.status === "on") return "Ohm is already on";
    const r = rates(c);
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
  const s = pet[key];
  pet[key] = { v: Math.min(MAX, valueNow(s, now) + GAIN[action]), at: now, rate: s.rate };
  return null;
}