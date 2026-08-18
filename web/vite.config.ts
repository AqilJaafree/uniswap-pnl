import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy /rpc straight to the public RPC (no paid key needed locally), so
// the app behaves the same as production (server.mjs) without CORS issues.
//
// The wallet lane is a NO-OP here, deliberately: `rewrite` drops the path and its query,
// so /rpc?lane=wallet lands on the same public endpoint as everything else. Local work
// needs no paid key, and a lane that silently spent one would be worse than none.
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
