// Loads the C++ code, compiled to WebAssembly by `npm run build:wasm`.
// Workers can't compile WebAssembly at runtime, so wrangler bundles the .wasm file.
import mod from "./pet.wasm";

type Pet = {
  add(a: number, b: number): number;
};

export const pet = new WebAssembly.Instance(mod).exports as unknown as Pet;