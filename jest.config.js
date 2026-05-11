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
  collectCoverageFrom: ["src/**/*.ts", "!src/index.ts"],
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
