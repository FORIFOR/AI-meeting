/**
 * Spoken-conversation reality gate — no human, no microphone.
 *
 * Synthesises Japanese turns with macOS `say`, streams them into services/agent as 16 kHz PCM in real
 * time, and captures the audio that comes back. The reply audio is written to a WAV and fed back through
 * the same STT, so "the voice works" is settled by what the bytes say rather than by a status field.
 *
 *   pnpm reality:converse                 # the default three turns
 *   pnpm reality:converse "ゆいさん、こんにちは" "得意なことは？"
 *
 * Needs the local stack: scripts/local-stack.sh start && pnpm --filter @rcai/agent dev
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
// `ws` is a dependency of services/agent, not of the repo root — resolve it from there.
const WebSocket = createRequire(new URL("../../services/agent/package.json", import.meta.url))("ws");

const AGENT = process.env.AGENT_URL ?? "ws://127.0.0.1:8788/session";
const TURNS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["ゆいさん、聞こえていますか。自己紹介をお願いします。", "ありがとう。ゆいさんは、どんなことが得意ですか。", "なるほど。では、面接の練習を手伝ってもらえますか。"];

const S = mkdtempSync(join(tmpdir(), "rcai-converse-"));
const files = TURNS.map((text, i) => {
  const aiff = join(S, `q${i}.aiff`), wav = join(S, `q${i}.wav`);
  execFileSync("say", ["-v", "Kyoko", "-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@48000", "-c", "1", aiff, wav]);
  return wav;
});

function readWav(path) {
  const b = readFileSync(path);
  let off = 12, rate = 48000, ch = 1, dOff = 0, dLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "fmt ") { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); }
    if (id === "data") { dOff = off + 8; dLen = size; break; }
    off += 8 + size + (size % 2);
  }
  const src = new Int16Array(b.buffer, b.byteOffset + dOff, Math.floor(dLen / 2));
  const ratio = rate / 16000, outLen = Math.floor(src.length / ch / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) pcm[i] = src[Math.floor(i * ratio) * ch] ?? 0;
  return pcm;
}

const frame = (chunk) => {
  const out = Buffer.alloc(12 + chunk.byteLength);
  out.writeUInt32LE(16000, 0); out.writeUInt32LE(0, 4); out.writeUInt32LE(0, 8);
  Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(out, 12);
  return out;
};

const sock = new WebSocket(AGENT);
const replyAudio = [];       // Int16Array chunks that came back
let outRate = 24000;
let turn = 0, t0 = 0;
const transcript = [];

function speak(pcm) {
  return new Promise((done) => {
    let i = 0; const step = 320;                       // 20 ms frames, real time
    const timer = setInterval(() => {
      if (i >= pcm.length) { clearInterval(timer); done(); return; }
      sock.send(frame(pcm.subarray(i, Math.min(i + step, pcm.length))), { binary: true });
      i += step;
    }, 20);
  });
}
function silence(ms) {
  return new Promise((done) => {
    const chunks = Math.floor(ms / 20); let i = 0;
    const quiet = new Int16Array(320);
    const timer = setInterval(() => {
      if (i++ >= chunks) { clearInterval(timer); done(); return; }
      sock.send(frame(quiet), { binary: true });
    }, 20);
  });
}

sock.on("open", async () => {
  sock.send(JSON.stringify({ type: "start", config: {
    systemPrompt: "あなたは会議に同席しているキャラクター「Yui」です。日本語で、1〜2文の短い話し言葉で答えてください。",
    mode: "free_talk", language: "ja-JP", privacyMode: "default", characterId: "yui", personaId: "friendly",
  }}));
  await silence(300);
  for (const f of files) {
    turn++; t0 = Date.now();
    console.log(`\n──── turn ${turn} ────`);
    await speak(readWav(f));
    await silence(9000);            // let the endpoint fire and the reply stream back
  }
  await silence(2000);
  finish();
});

sock.on("message", (data, isBinary) => {
  if (isBinary) {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    outRate = b.readUInt32LE(0);
    const body = b.subarray(12);
    replyAudio.push(new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength - (body.byteLength % 2))));
    return;
  }
  const m = JSON.parse(data.toString());
  if (m.type === "user_transcript" && m.final) { console.log(`  聞き取り : ${m.text}`); transcript.push(["user", m.text]); }
  else if (m.type === "assistant_transcript" && m.final) { console.log(`  Yui     : ${m.text}  (+${Date.now() - t0}ms)`); transcript.push(["yui", m.text]); }
  else if (m.type === "metrics") { const t = m.turn ?? {}; console.log(`  metrics : 初回音声 ${t.firstAudioSentMs}ms · TTS初音 ${t.ttsTtfaMs}ms · 全体 ${t.totalMs}ms`); }
  else if (m.type === "error") console.log(`  ERROR   : ${m.message}`);
});

let finished = false;
function finish() {
  if (finished) return; finished = true;
  const total = replyAudio.reduce((n, a) => n + a.length, 0);
  const pcm = new Int16Array(total);
  let o = 0; for (const a of replyAudio) { pcm.set(a, o); o += a.length; }
  let peak = 0; for (let i = 0; i < pcm.length; i += 7) peak = Math.max(peak, Math.abs(pcm[i]));
  const seconds = total / outRate;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(outRate, 24); header.writeUInt32LE(outRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.byteLength, 40);
  writeFileSync(`${S}/yui-reply.wav`, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]));
  console.log(`\n=== 返ってきた音声 : ${seconds.toFixed(1)}s @ ${outRate}Hz · ピーク ${(peak / 32768 * 100).toFixed(0)}% · ${S}/yui-reply.wav`);
  const replies = transcript.filter(([r]) => r === "yui").length;
  console.log(`=== やり取り ${replies} 応答 / ${transcript.filter(([r]) => r === "user").length} 発話`);
  if (replies < TURNS.length || seconds < 1 || peak < 0.02 * 32768) {
    console.error("FAIL: 応答数または音声が不足しています");
    sock.close(); process.exit(1);
  }
  sock.close(); process.exit(0);
}
setTimeout(finish, 75000);
