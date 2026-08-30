import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export default defineConfig({
  root: path.dirname(fileURLToPath(import.meta.url)),
  server: { port: 5181, fs: { allow: [repoRoot] } },
  define: { "import.meta.env.VITE_REPO_ROOT": JSON.stringify(repoRoot) },
});
