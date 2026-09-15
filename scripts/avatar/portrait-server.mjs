// Local authoring tool: renders installed character models; never uploads to an avatar service.
import { createServer } from '../../apps/web/node_modules/vite/dist/node/index.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(root, 'artifacts/anam-portraits');
const ids = new Set(['yui', 'haru', 'kei', 'reina']);
const server = await createServer({
  root: resolve(root, 'apps/web'),
  server: { host: '127.0.0.1', port: 5187, strictPort: true, fs: { allow: [root] } },
  plugins: [{ name: 'portrait-authoring', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url === '/__portrait') {
        const html = await readFile(new URL('./portrait.html', import.meta.url), 'utf8');
        res.setHeader('Content-Type', 'text/html');
        res.end(await vite.transformIndexHtml('/__portrait', html.replaceAll('__REPO_ROOT__', root.replace(/\/$/, ''))));
        return;
      }
      const match = /^\/__portrait\/save\/(yui|haru|kei|reina)$/.exec(req.url ?? '');
      if (match && req.method === 'POST' && ids.has(match[1])) {
        // Only this loopback authoring page may write one of four named local images.
        if (req.headers.origin !== 'http://127.0.0.1:5187') { res.statusCode = 403; res.end(); return; }
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4_500_000) { res.statusCode = 413; res.end(); return; }
          chunks.push(chunk);
        }
        const png = Buffer.concat(chunks);
        if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) < 1152 || png.readUInt32BE(16) !== png.readUInt32BE(20)) {
          res.statusCode = 400; res.end('A square PNG of at least 1152px is required.'); return;
        }
        await mkdir(out, { recursive: true });
        await writeFile(resolve(out, `${match[1]}.png`), png);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ saved: `${match[1]}.png`, bytes: png.length, width: png.readUInt32BE(16) }));
        return;
      }
      next();
    });
  } }],
});
await server.listen();
console.log('Portrait authoring: http://127.0.0.1:5187/__portrait');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
