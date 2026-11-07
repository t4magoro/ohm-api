// Lets Node run the TypeScript tools and the sources they import: an extensionless import finds its .ts file.
// Run with: node --import ./tools/resolve.mjs tools/<tool>.ts
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
