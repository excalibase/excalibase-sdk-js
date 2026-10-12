import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/codegen/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2020",
    platform: "neutral",
    treeshake: true,
  },
  {
    entry: { "bin/codegen": "src/bin/codegen.ts" },
    format: ["cjs"],
    sourcemap: false,
    target: "node18",
    platform: "node",
    banner: { js: "#!/usr/bin/env node" },
    noExternal: ["json-schema-to-typescript"],
    shims: true,
    // Prefer each package's CommonJS entry: some of its dependencies patch module.exports in their ESM build.
    esbuildOptions(options) {
      options.mainFields = ["main", "module"];
    },
    clean: false,
  },
]);
