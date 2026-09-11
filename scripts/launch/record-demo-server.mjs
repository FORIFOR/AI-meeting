// Development-only, loopback capture server. Never serves credentials or touches production settings.
import { createServer } from '../../apps/web/node_modules/vite/dist/node/index.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.env.RCAI_CAPTURE_DIR ?? '/private/tmp/ai-meeting-launch-capture';
const origin = 'http://127.0.0.1:5180';
const broker = process.env.RCAI_CAPTURE_BROKER ?? 'http://localhost:8787';
const prompts = [
  '今日のタスクを二つ記録してください。タスク名は、資料確認とメール返信です。どちらも期限は今日です。二つを記録して、短く確認してください。',
  '変更です。資料確認は完了しました。メール返信は明日に延期してください。今の状態を短く教えてください。',
  '今の記録を読んで、二つのタスクの状態を短く教えてください。',
];
await mkdir(output, { recursive: true });
if (process.argv.includes('--prepare-voice')) {
  if (process.platform !== 'darwin') throw new Error('Prepare voice fixtures with macOS say, or place 1.wav / 2.wav in RCAI_CAPTURE_DIR.');
  const execute = promisify(execFile);
  for (let i = 0; i < prompts.length; i++) {
    const text = path.join(output, `${i + 1}.txt`);
    await writeFile(text, prompts[i]);
    await execute('/usr/bin/say', ['-v', 'Kyoko', '-r', '220', '--file-format=WAVE', '--data-format=LEI16@48000', '-f', text, '-o', path.join(output, `${i + 1}.wav`)], { timeout: 30000 });
  }
  console.log('Prepared original, synthetic Japanese inputs locally.');
}
const server = await createServer({
  configFile: false, root: path.join(root, 'scripts/launch'), cacheDir: path.join(output, '.vite'),
  publicDir: path.join(root, 'apps/web/public-oss'),
  define: { 'import.meta.env.VITE_RCAI_OSS': '"false"' },
  server: { host: '127.0.0.1', port: 5180, strictPort: true, hmr: false, fs: { allow: [root] } },
  plugins: [{ name: 'local-real-session-recording', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      try {
        const url = new URL(req.url ?? '/', origin);
        res.setHeader('Cache-Control', 'no-store');
        if (url.pathname === '/') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          const html = await readFile(path.join(root, 'scripts/launch/record-demo.html'), 'utf8');
          res.end(await vite.transformIndexHtml('/', html)); return;
        }
        if (url.pathname === '/capture/config') {
          const persona = JSON.parse(await readFile(path.join(root, 'personas/tasks/task_organizer_ja.json'), 'utf8'));
          delete persona.opening; // This recording starts with the supplied input, not an opening monologue.
          const available = await Promise.all(prompts.map((_, index) => readFile(path.join(output, `${index + 1}.wav`)).then(() => true).catch(() => false)));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ broker, persona, prompts, available, durationLimitSeconds: 60 })); return;
        }
        const fixture = /^\/capture\/input\/([123])\.wav$/.exec(url.pathname);
        if (fixture) { res.setHeader('Content-Type', 'audio/wav'); res.end(await readFile(path.join(output, `${fixture[1]}.wav`))); return; }
        const save = /^\/capture\/([a-f0-9-]{36})\/(video|evidence)$/.exec(url.pathname);
        if (save && req.method === 'POST') {
          if (req.headers.origin !== origin) { res.statusCode = 403; res.end(); return; }
          const maximum = save[2] === 'video' ? 100 * 1024 * 1024 : 1024 * 1024;
          const chunks = []; let bytes = 0;
          for await (const chunk of req) { bytes += chunk.length; if (bytes > maximum) { res.statusCode = 413; res.end(); return; } chunks.push(chunk); }
          const body = Buffer.concat(chunks);
          const extension = save[2] === 'video' ? 'webm' : 'json';
          if (extension === 'json') JSON.parse(body.toString());
          await writeFile(path.join(output, `${save[1]}.${extension}`), body, { mode: 0o600 });
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ saved: true, file: `${save[1]}.${extension}` })); return;
        }
        next();
      } catch { res.statusCode = 500; res.end('Capture resource unavailable.'); }
    });
  } }],
});
await server.listen();
console.log(`Recording controls: ${origin}/ (no API request until Start)`);
console.log(`Local output: ${output}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
