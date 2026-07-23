import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy /rpc straight to the public RPC (no paid key needed locally), so
// the app behaves the same as production (server.mjs) without CORS issues.
const DEV_RPC = process.env.PUBLIC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/rpc": {
        target: DEV_RPC,
        changeOrigin: true,
        rewrite: () => "/",
      },
    },
  },
});
