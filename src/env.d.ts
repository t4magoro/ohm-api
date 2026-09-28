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

// Secrets: .dev.vars locally, the Cloudflare dashboard for the live Worker. They can't go in
// wrangler.jsonc (it's public), so their types are declared here instead.
interface Env {
  ADMIN_TOKEN: string;
  IP_SALT: string;
}