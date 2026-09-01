import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite proxies /graphql + /api/v1 to excalibase-graphql at :10004 so the
// browser sees a same-origin URL — no CORS preflight needed for PATCH
// (cart checkout, admin inventory edits).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    host: true,
    proxy: {
      "/graphql": { target: "http://localhost:10004", changeOrigin: true },
      "/api/v1":  { target: "http://localhost:10004", changeOrigin: true },
    },
  },
});
