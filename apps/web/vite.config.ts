import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");
/**
 * The meeting bot loads this app through a public tunnel (Recall Output Media), so the dev and
 * preview servers must accept that Host. Quick Tunnels are *.trycloudflare.com; anything else can be
 * allowed with RCAI_ALLOWED_HOSTS=host1,host2.
 */
const allowedHosts = [".trycloudflare.com", ".ngrok-free.app", ".ngrok.io", ...(process.env.RCAI_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? [])];

export default defineConfig({
  plugins: [react()],
  publicDir: "public",
  preview: { port: 5180, allowedHosts },
  server: {
    port: 5173,
    allowedHosts,
    fs: { allow: [repoRoot] },
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
      "/agent": { target: "http://localhost:8788", changeOrigin: true, ws: true, rewrite: (p) => p.replace(/^\/agent/, "") },
    },
  },
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 2000 },
});
