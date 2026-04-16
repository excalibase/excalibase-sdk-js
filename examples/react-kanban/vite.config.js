import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        // Proxy the auth + graphql + rest endpoints so the browser only ever
        // talks to the Vite dev server origin — no CORS headaches, no manual
        // auth base URL config.
        proxy: {
            "/auth": {
                target: "http://localhost:24004",
                changeOrigin: true,
            },
            "/graphql": {
                target: "http://localhost:10004",
                changeOrigin: true,
            },
            "/api/v1": {
                target: "http://localhost:10004",
                changeOrigin: true,
            },
        },
    },
});
