/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  // json-schema-to-typescript's CJS entry eagerly imports prettier's ESM
  // entry. Jest's VM doesn't satisfy dynamic ESM imports without the
  // --experimental-vm-modules flag. Since we disable prettier formatting
  // via the `format: false` codegen option, a CJS stub is functionally
  // equivalent and avoids the flag.
  moduleNameMapper: {
    "^prettier$": "<rootDir>/test/stubs/prettier-stub.js",
  },
  // Exclude entry points (src/index.ts) and CLI bin scripts
  // (src/bin/codegen.ts) from coverage collection. Both are I/O shells
  // exercised by integration / live tests rather than the unit suite that
  // gates this threshold; including them would let the bin script's
  // argv-parsing branches drag the global down without any signal about
  // the library's correctness.
  collectCoverageFrom: ["src/**/*.ts", "!src/index.ts", "!src/bin/codegen.ts"],
  coverageThreshold: {
    global: {
      branches: 75,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          target: "ES2020",
          module: "commonjs",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          lib: ["ES2020", "DOM"],
        },
      },
    ],
  },
  setupFiles: ["<rootDir>/test/setup.ts"],
};
