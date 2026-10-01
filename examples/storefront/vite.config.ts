/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the SPA on :5176. In development the project comes from
// VITE_EXCALIBASE_* variables (see README); in the container, from /config.js.
export default defineConfig({
  plugins: [react()],
  server: { port: 5176, host: true },
  preview: { port: 5176 },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
