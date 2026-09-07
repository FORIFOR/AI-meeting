/**
 * A conversation on the real Gemini Live path, without a meeting.
 *
 * Usage: services/agent/node_modules/.bin/tsx scripts/reality/gemini-conversation.ts <utterance.wav ...>
 *   NOISE=0.01     room tone mixed under every frame (~-40 dBFS, an AGC'd meeting stream's silence)
 *   HANGOVER=700   override the gate's quiet-before-close, to measure what it costs
 *
 * It drives the real provider — the gate, the half-duplex hold and the turn telemetry — with the
 * room's own recorded utterances laid over room tone, paced in real time so the latencies mean
 * something. What it cannot show is a meeting: for that there is `reality:attendee:human`.
 */
import { readFileSync } from "node:fs";
import { GeminiLiveProvider } from "../../providers/gemini/src/geminiLiveProvider.js";
import { createFrame } from "../../packages/audio-core/src/types.js";

const UTT = process.argv.slice(2);
const NOISE = Number(process.env.NOISE ?? "0.01");
const readWav = (p: string) => {
  const raw = readFileSync(p);
  let off = 12, data: Buffer | null = null, rate = 16000;
  while (off + 8 <= raw.length) {
    const id = raw.toString("ascii", off, off + 4), size = raw.readUInt32LE(off + 4);
    if (id === "fmt ") rate = raw.readUInt32LE(off + 12);
    if (id === "data") { data = raw.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`no data in ${p}`);
  const f = new Float32Array(data.length / 2);
  for (let i = 0; i < f.length; i++) f[i] = data.readInt16LE(i * 2) / 32768;
  return { f, rate };
};

const provider = new GeminiLiveProvider({ brokerUrl: "http://localhost:8787", ...(process.env.HANGOVER ? { gateHangoverMs: Number(process.env.HANGOVER) } : {}) } as never);
type Turn = { asked: string; heard: string; said: string; firstAudioMs: number | null; completeMs: number | null; metrics?: Record<string, number> };
let cur: Turn | null = null;
let endedAt = 0;
const turns: Turn[] = [];
provider.onEvent((e: { type: string; [k: string]: unknown }) => {
  if (!cur) return;
  if (e.type === "assistant_audio" && cur.firstAudioMs === null) cur.firstAudioMs = Date.now() - endedAt;
  else if (e.type === "assistant_transcript") cur.said = e.final !== false ? (e.text as string) : cur.said + (e.text as string);
  else if (e.type === "user_transcript" && e.final !== false) cur.heard += e.text as string;
  else if (e.type === "metrics") cur.metrics = (e as unknown as { turn: Record<string, number> }).turn;
  else if (e.type === "assistant_speech_ended") cur.completeMs = Date.now() - endedAt;
  else if (e.type === "error") console.log("  ! error", String((e.error as Error)?.message).slice(0, 140));
});

await provider.connect({ language: "ja-JP", systemPrompt: "あなたはYui、日本語で話す同僚のAIです。自然な話し言葉で1〜3文。", privacyMode: "cloud", providerOptions: { autoRespond: false } } as never);
const rate = 16000, FRAME = rate * 0.02;
// Browser-style media time: the page stamps frames with performance.now(), and the telemetry compares
// a VAD timestamp with the clock, so the probe must stamp them the same way.
let t = performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noise = () => Float32Array.from({ length: FRAME }, () => (Math.random() * 2 - 1) * NOISE);
const push = (d: Float32Array) => { provider.pushAudio(createFrame(d, rate, t)); t += 20; };
/** Real-time room tone for `ms`, so the latencies mean something. */
const tone = async (ms: number) => { for (let i = 0; i < ms / 20; i++) { push(noise()); await sleep(20); } };

for (const path of UTT) {
  const { f } = readWav(path);
  const label = path.split("_").pop()!.replace(".wav", "");
  cur = { asked: label, heard: "", said: "", firstAudioMs: null, completeMs: null };
  await tone(700);
  for (let o = 0; o + FRAME <= f.length; o += FRAME) {
    const n = noise(), out = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) out[i] = f[o + i]! + n[i]!;
    push(out); await sleep(20);
  }
  endedAt = Date.now();
  await tone(9000); // the room waits, as a person would
  turns.push(cur);
  const m = cur.metrics ? ` firstAudioSent=${cur.metrics.firstAudioSentMs}ms total=${cur.metrics.totalMs}ms` : "";
  console.log(`Q ${label}\n  heard ${JSON.stringify(cur.heard)}\n  said  ${JSON.stringify(cur.said)}\n  firstAudio ${cur.firstAudioMs ?? "NONE"}ms${m}`);
  cur = null;
}
const g = (provider as never as { gateStats: Record<string, number> }).gateStats;
const lat = turns.map((x) => x.firstAudioMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((lat.length * p) / 100))] : null);
const sent = turns.map((x) => x.metrics?.firstAudioSentMs).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
console.log(`speech end → first sound: p50 ${Math.round(sent[Math.floor(sent.length / 2)] ?? 0)}ms of ${sent.length}`);
console.log(`\nanswered ${lat.length}/${turns.length}  first audio p50 ${pct(50)}ms p95 ${pct(95)}ms max ${lat[lat.length - 1]}ms`);
console.log(`gate ${JSON.stringify(g)}  (sent ${(100 * g.sent / (g.sent + g.held)).toFixed(0)}% of the room's audio)`);
await provider.disconnect();
process.exit(0);
