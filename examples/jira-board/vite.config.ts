import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pinned to 5175 to avoid colliding with other example demos that
// default to 5173/5174.
//
// Vite proxies /graphql + /api/v1 to the excalibase-graphql container
// at :10004, so the browser sees a same-origin URL and CORS preflight
// is bypassed entirely. The SDK's `url` option points at
// `window.location.origin` via the env default (`VITE_API_URL`).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    host: true,
    proxy: {
      "/graphql": { target: "http://localhost:10004", changeOrigin: true },
      "/api/v1":  { target: "http://localhost:10004", changeOrigin: true },
    },
  },
});
