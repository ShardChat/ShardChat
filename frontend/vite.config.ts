import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev proxy keeps the browser same-origin: REST under /api and the
// WebSocket rendezvous under /ws are forwarded to the Go blind relay.
// Proxy socket errors (client bailed mid-relay, room burned) are logged
// as one compact line instead of a full ECONNABORTED stack trace.
const quietProxyError = (prefix: string) => (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes("ECONNRESET") && !msg.includes("ECONNABORTED")) {
    console.warn(`[shard-proxy] ${prefix}: ${msg}`);
  }
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", quietProxyError("api"));
        },
      },
      "/ws": {
        // http:// + ws:true is the stable Vite/http-proxy combo. A ws://
        // target aborts the upgrade on Windows (ECONNABORTED) before Go
        // ever sees the handshake.
        target: "http://localhost:8080",
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on("error", quietProxyError("ws"));
        },
      },
    },
  },
});
