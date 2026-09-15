// Loopback-only, offline avatar validation. Generated OS voice fixtures never enter the repository.
import { createServer } from '../../apps/web/node_modules/vite/dist/node/index.js';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = '/private/tmp/ai-meeting-vrm-validation';
const origin = 'http://127.0.0.1:5182';
const sentences = [
  'こんにちは。今日もよろしくお願いします。', '予定を一緒に確認しましょう。', '午後三時に打ち合わせがあります。', '資料は明日の朝にまとめます。', 'まず目的を短く説明します。',
  '参加者は全部で五人です。', '音声は聞こえていますか。', 'はい、はっきり聞こえています。', '小さな変更から始めましょう。', '大切な点を二つ挙げます。',
  '雨の日は足元に気をつけてください。', '青い箱を右側に置きます。', '赤い花がきれいに咲きました。', '温かいお茶を用意しました。', 'ゆっくり話しても大丈夫です。',
  'その考え方は分かりやすいですね。', '別の方法も試してみましょう。', '少し考える時間をください。', '次の質問に進んでもよいですか。', '確認できたらお知らせします。',
  '新しい案を三つ考えました。', '数字をもう一度読み上げます。', '一、二、三、四、五、六、七、八。', '会議は十時半に終わる予定です。', '今日の結論を短くまとめます。',
  '担当する人を先に決めましょう。', '締め切りは金曜日の正午です。', 'ここまでの説明は伝わりましたか。', '分からない点は遠慮なく聞いてください。', 'お手伝いできてうれしいです。',
  'すばらしい進歩ですね。', '難しいところも一緒に考えます。', '慌てず順番に進めましょう。', '最初の一歩が大切です。', 'お疲れさまでした。少し休みましょう。',
  '玄関の鍵を忘れないでください。', '駅まで歩いて十分です。', '白い雲がゆっくり流れています。', '風が少し涼しくなりました。', '本を開いて続きを読みます。',
  'このページには図が二つあります。', '右の図を見ると違いが分かります。', '短い文で要点を伝えます。', 'あいうえおを順番に発音します。', 'ぱぴぷぺぽ、まみむめも。',
  '静かな場所で確認しています。', '今の言葉を訂正します。', '次回は別の案を紹介します。', 'ご協力ありがとうございます。', 'それでは、またお会いしましょう。',
];
await mkdir(output, { recursive: true });
const manifest = sentences.map((text, index) => ({ id: index + 1, text, wav: `/test-fixtures/${String(index + 1).padStart(2, '0')}.wav` }));
await writeFile(resolve(output, 'sentences.json'), JSON.stringify({ origin: 'Original Japanese validation sentences; locally synthesized by macOS say', voice: 'Kyoko', rate: 230, items: manifest }, null, 2));

if (process.argv.includes('--prepare-fixtures')) {
  if (process.platform !== 'darwin') throw new Error('Fixture authoring requires macOS say; provide local WAV fixtures on other hosts.');
  const execute = promisify(execFile);
  for (const row of manifest) {
    const stem = String(row.id).padStart(2, '0');
    const wav = resolve(output, `${stem}.wav`);
    if (await stat(wav).then((s) => s.size > 44).catch(() => false)) continue;
    const text = resolve(output, `${stem}.txt`);
    await writeFile(text, row.text);
    await execute('/usr/bin/say', ['-v', 'Kyoko', '-r', '230', '--file-format=WAVE', '--data-format=LEI16@48000', '-o', wav, '-f', text], { timeout: 30_000 });
    console.log(`Prepared local fixture ${row.id}/50`);
  }
}

const server = await createServer({
  configFile: false,
  root: resolve(root, 'apps/web'),
  publicDir: resolve(root, 'apps/web/public'),
  cacheDir: resolve(output, 'vite-cache'),
  server: { host: '127.0.0.1', port: 5182, strictPort: true, hmr: false, fs: { allow: [root] } },
  plugins: [{ name: 'offline-vrm-validation', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      try {
        const url = new URL(req.url ?? '/', origin);
        if (url.pathname === '/' || url.pathname === '/__vrm-validation') {
          const source = await readFile(new URL('./vrm-validation.html', import.meta.url), 'utf8');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Security-Policy', "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; connect-src 'self' blob: data:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; media-src 'self' blob:");
          res.end(await vite.transformIndexHtml('/__vrm-validation', source.replaceAll('__REPO_ROOT__', root.replace(/\/$/, ''))));
          return;
        }
        if (url.pathname === '/validation/config') {
          const available = await Promise.all(manifest.map((row) => stat(resolve(output, row.wav.split('/').at(-1))).then((s) => s.size > 44).catch(() => false)));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ fixtures: manifest, available: available.filter(Boolean).length, output }));
          return;
        }
        const fixture = /^\/test-fixtures\/([0-9]{2})\.wav$/.exec(url.pathname);
        if (fixture && Number(fixture[1]) >= 1 && Number(fixture[1]) <= 50) {
          const data = await readFile(resolve(output, `${fixture[1]}.wav`));
          res.setHeader('Content-Type', 'audio/wav'); res.end(data); return;
        }
        if (url.pathname === '/validation/evidence' && req.method === 'POST') {
          if (req.headers.origin !== origin) { res.statusCode = 403; res.end(); return; }
          const chunks = []; let length = 0;
          for await (const chunk of req) { length += chunk.length; if (length > 1_000_000) { res.statusCode = 413; res.end(); return; } chunks.push(chunk); }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body !== 'object' || typeof body.runId !== 'string') { res.statusCode = 400; res.end(); return; }
          await appendFile(resolve(output, 'evidence.jsonl'), JSON.stringify({ savedAt: new Date().toISOString(), ...body }) + '\n');
          res.setHeader('Content-Type', 'application/json'); res.end('{"saved":true}'); return;
        }
        next();
      } catch (error) { res.statusCode = 500; res.end(String(error.message).slice(0, 200)); }
    });
  } }],
});
await server.listen();
console.log(`Offline validation: ${origin}/__vrm-validation`);
console.log(`Evidence and generated voice fixtures: ${output}`);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
