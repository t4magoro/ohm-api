// Loads the C++ pet math, compiled to WebAssembly by `npm run build:wasm`.
// Workers can't compile WebAssembly at runtime, so wrangler bundles the .wasm file.
import mod from "./pet.wasm";

type PetMath = {
  memory: WebAssembly.Memory;
  value_now(v: number, at: number, rate: number, now: number): number;
  empty_at(v: number, at: number, rate: number): number;
  charge_rate(hours: number, tempC: number, isDay: number): number;
  mood_rate(hours: number, raining: number, isDay: number): number;
  brain_level(vocab: number): number;
  lang_level(words: number): number;
  weights_ptr(): number;
  pick_weighted(n: number, r: number): number;
};

export const math = new WebAssembly.Instance(mod).exports as unknown as PetMath;