import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  plugins: [react()],
  publicDir: "public",
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
      "/agent": { target: "http://localhost:8788", changeOrigin: true, ws: true, rewrite: (p) => p.replace(/^\/agent/, "") },
    },
  },
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 2000 },
});
