// Lets TypeScript import the compiled C++ (pet.wasm) as a WebAssembly module.
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}