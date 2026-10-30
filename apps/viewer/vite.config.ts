import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    strictPort: true,
    // The Host stays localhost:5173, which is in the dev MORE_URLS, as cookies and Origin will need in M2.
    proxy: { "/api": "http://localhost:8080" },
  },
});
