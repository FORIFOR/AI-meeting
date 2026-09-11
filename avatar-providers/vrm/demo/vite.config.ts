import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export default defineConfig({
  root: path.dirname(fileURLToPath(import.meta.url)),
  publicDir: path.join(repoRoot, "apps/web/public-oss"),
  server: { port: 5181, fs: { allow: [repoRoot] } },
  define: { "import.meta.env.VITE_RCAI_OSS": JSON.stringify("true") },
});
