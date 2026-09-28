// Loads the C++ pet math, compiled to WebAssembly by `npm run build:wasm`.
// Workers can't compile WebAssembly at runtime, so wrangler bundles the .wasm file.
import mod from "./pet.wasm";

type PetMath = {
  value_now(v: number, at: number, rate: number, now: number): number;
  empty_at(v: number, at: number, rate: number): number;
  charge_rate(tempC: number, isDay: number): number;
  mood_rate(raining: number, isDay: number): number;
};

export const math = new WebAssembly.Instance(mod).exports as unknown as PetMath;