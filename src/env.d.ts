// Lets TypeScript import the compiled C++ (pet.wasm) as a WebAssembly module.
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}

// Word lists (wordlists/*.txt): wrangler bundles them as plain text.
declare module "*.txt" {
  const text: string;
  export default text;
}