import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFile } from "node:fs/promises";

const repoRoot = path.resolve(__dirname, "../..");
/**
 * The meeting bot loads this app through a public tunnel (Recall Output Media), so the dev and
 * preview servers must accept that Host. Quick Tunnels are *.trycloudflare.com; anything else can be
 * allowed with RCAI_ALLOWED_HOSTS=host1,host2.
 */
const allowedHosts = [".trycloudflare.com", ".ngrok-free.app", ".ngrok.io", ...(process.env.RCAI_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? [])];

export default defineConfig(({ mode }) => {
  const oss = mode === "oss";
  return {
  plugins: [react(), {
    name: "vrm-runtime-notices",
    async generateBundle() {
      const notices = ["VRM rendering runtime notices. These licenses do not apply to the character model or application code."];
      for (const name of ["three", "@pixiv/three-vrm", "wlipsync"]) {
        const directory = path.join(repoRoot, "avatar-providers/vrm/node_modules", name);
        const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
        notices.push(`${name}@${metadata.version}\n\n${await readFile(path.join(directory, "LICENSE"), "utf8")}`);
      }
      notices.push(`wLipSync profile\n\n${await readFile(path.join(repoRoot, "avatar-providers/vrm/src/wlipsync-profile.LICENSE"), "utf8")}`);
      this.emitFile({ type: "asset", fileName: "VRM-THIRD-PARTY-NOTICES.txt", source: notices.join("\n\n---\n\n") });
    },
  }, ...(oss ? [{ name: "oss-local-document", transformIndexHtml(html: string) {
    return html.replace(/<link\b[^>]*href="https:\/\/fonts\.[\s\S]*?>/g, "");
  } }] : [])],
  define: { "import.meta.env.VITE_RCAI_OSS": JSON.stringify(oss ? "true" : "false") },
  resolve: oss ? { alias: Object.fromEntries(["@rcai/avatar-anam", "@rcai/avatar-live2d", "@rcai/avatar-liveavatar", "@rcai/avatar-tavus"].map(name => [name, path.resolve(__dirname, "src/integrations/disabledAvatar.ts")])) } : undefined,
  publicDir: oss ? "public-oss" : "public",
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
  build: { outDir: oss ? "dist-oss" : "dist", target: "es2022", sourcemap: true, chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { main: path.resolve(__dirname, "index.html"), "vrm-demo": path.resolve(__dirname, "vrm-demo.html") } } },
};
});
