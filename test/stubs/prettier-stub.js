// Jest stub for `prettier` — the codegen path passes `format: false` so
// json-schema-to-typescript never actually calls prettier, but the package
// eagerly does `import("./index.mjs")` at CJS load time which Jest's VM
// can't satisfy without --experimental-vm-modules. This stub short-circuits
// the load with the small surface json-schema-to-typescript references
// (format, resolveConfig). At runtime in the published package, the real
// prettier is loaded by Node's normal CJS path — only Jest needs this.
"use strict";
module.exports = {
  format: (src) => Promise.resolve(typeof src === "string" ? src : ""),
  formatWithCursor: (src) => Promise.resolve({ formatted: typeof src === "string" ? src : "", cursorOffset: -1 }),
  check: () => Promise.resolve(false),
  resolveConfig: () => Promise.resolve(null),
  resolveConfigFile: () => Promise.resolve(null),
  clearConfigCache: () => undefined,
  getFileInfo: () => Promise.resolve({ ignored: false, inferredParser: null }),
  getSupportInfo: () => Promise.resolve({ languages: [], options: [] }),
  version: "0.0.0-stub",
};
