import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The dev server proxies the WebSocket and REST paths to the backend, so the app
// always talks to its own origin. BACKEND_URL defaults to the server's PORT (3000),
// which is also where `npm run mock:dashboard` listens.
const backend = process.env.BACKEND_URL ?? "http://localhost:3000";
const wsPath = process.env.DASHBOARD_WS_PATH ?? "/ws/dashboard";

export default defineConfig({
  plugins: [react()],
  define: {
    __DASHBOARD_WS_PATH__: JSON.stringify(wsPath),
  },
  server: {
    port: 5173,
    proxy: {
      [wsPath]: { target: backend.replace(/^http/, "ws"), ws: true },
      "/api": { target: backend },
    },
  },
  test: {
    environment: "node",
  },
});
