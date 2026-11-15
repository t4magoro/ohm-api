// What's happening around Ohm right now, as simple on/off facts. Ohm learns which words people use
// in which situation (brain.ts). The thresholds were tested in ohm-app/research/brain_sim.ipynb.
import { valueNow } from "./pet";
import type { Care, Pet, Situation, Weather } from "./protocol";
export type { Care, Situation }; // defined in protocol.ts: the site shows situations on the Vitals page

const HOUR = 3_600_000;
const BANDUNG = 7 * HOUR; // UTC+7 all year
const HOT_C = 30; // the same line as the faster battery drain in pet.cpp
const BATTERY_LOW = 50; // at 30, Ohm was hungry too rarely to learn "lapar"
const MOOD_LOW = 30; // at 50, "sad" was on so often that it lined up with everything
const CARE_MEMORY_MS = 60_000; // a message within a minute of your own charge/play/reboot is about it

/** Bandung's part of the day: pagi 5–11, siang 11–15, sore 15–18, malam 18–5. */
export function partOfDay(now: number): Situation {
  const h = Math.floor((now + BANDUNG) / HOUR) % 24;
  return h >= 5 && h < 11 ? "pagi" : h >= 11 && h < 15 ? "siang" : h >= 15 && h < 18 ? "sore" : "malam";
}

/**
 * Brain v4's state tokens (talk.ts): battery, mood, weather and part of day, in the teacher's words. Low uses the
 * thresholds above; full is 80+ for both. ponytail: no cloud reading, so "berawan" never comes up; cold is under 20 °C.
 */
export function stateTokens(weather: Weather, pet: Pet, now: number): string[] {
  const charge = valueNow(pet.charge, now), mood = valueNow(pet.mood, now);
  return [
    charge < BATTERY_LOW ? "tipis" : charge >= 80 ? "penuh" : "setengah",
    mood < MOOD_LOW ? "sedih" : mood >= 80 ? "senang" : "biasa",
    weather.raining ? "hujan" : weather.tempC > HOT_C ? "panas" : weather.tempC < 20 ? "dingin" : "cerah",
    partOfDay(now),
  ];
}

/** Everything that's on right now. `lastCare` is what this visitor last did to Ohm, and when. */
export function situation(weather: Weather, pet: Pet, now: number, lastCare?: { t: Care; at: number }): Situation[] {
  const on: Situation[] = [partOfDay(now)];
  if (weather.raining) on.push("rain");
  if (weather.tempC > HOT_C) on.push("hot");
  if (valueNow(pet.charge, now) < BATTERY_LOW) on.push("battery_low");
  if (valueNow(pet.mood, now) < MOOD_LOW) on.push("mood_low");
  if (lastCare && now - lastCare.at < CARE_MEMORY_MS) on.push(lastCare.t);
  return on;
}