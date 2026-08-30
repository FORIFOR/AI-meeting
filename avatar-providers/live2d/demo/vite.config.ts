import { defineConfig, type Plugin } from "vite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const repoRoot = resolve(__dirname, "../../..");
const MIME: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".moc3": "application/octet-stream",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".wav": "audio/wav",
};

/** Serves /characters/* and /vendor/* straight from the repository root. */
function repoStatic(): Plugin {
  return {
    name: "rcai-repo-static",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0]!;
        if (!url.startsWith("/characters/") && !url.startsWith("/vendor/") && !url.startsWith("/tools/")) return next();
        const file = normalize(join(repoRoot, decodeURIComponent(url)));
        if (!file.startsWith(repoRoot) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [repoStatic()],
  server: { fs: { allow: [repoRoot] }, port: 5180, hmr: false },
  optimizeDeps: { include: ["pixi.js", "pixi-live2d-display/cubism4"] },
});
