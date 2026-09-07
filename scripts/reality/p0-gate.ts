/**
 * The five things a person notices, measured instead of asserted.
 *
 *   ① 勝手に喋らない          silence is not answered, and a meeting is not joined uninvited
 *   ② 呼んだらすぐ答える       first sound after the room stops
 *   ③ 人が喋ったらすぐ止まる    speech over her own reply cuts it
 *   ④ 短く自然に喋る          how long she talks for
 *   ⑤ 聞き取れなければ聞き返す  a half-heard sentence is asked back, not filled in
 *
 * Runs against the real model with recorded room audio over room tone, in real time, and needs no
 * meeting: the room is the one thing these five do not depend on. What it cannot show is a person's
 * judgement of the answers — that is what the Meet runs are for.
 *
 * Usage: services/agent/node_modules/.bin/tsx scripts/reality/p0-gate.ts <utt-dir>
 */
import { readFileSync, readdirSync } from "node:fs";
import { GeminiLiveProvider } from "../../providers/gemini/src/geminiLiveProvider.js";
import { createFrame } from "../../packages/audio-core/src/types.js";
import { ParticipationPolicy, meetingInstructions } from "../../packages/meeting-core/src/index.js";

const dir = process.argv[2]!;
const pick = (needle: string) => {
  const f = readdirSync(dir).filter((x) => x.endsWith(".wav") && x.includes(needle)).sort().pop();
  if (!f) throw new Error(`no recording matching ${needle}`);
  return `${dir}/${f}`;
};
const readWav = (p: string) => {
  const raw = readFileSync(p);
  let off = 12, data: Buffer | null = null;
  while (off + 8 <= raw.length) {
    const id = raw.toString("ascii", off, off + 4), size = raw.readUInt32LE(off + 4);
    if (id === "data") { data = raw.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`no data in ${p}`);
  const f = new Float32Array(data.length / 2);
  for (let i = 0; i < f.length; i++) f[i] = data.readInt16LE(i * 2) / 32768;
  return f;
};

const RATE = 16000, FRAME = RATE * 0.02;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noise = () => Float32Array.from({ length: FRAME }, () => (Math.random() * 2 - 1) * 0.01);

const provider = new GeminiLiveProvider({ brokerUrl: process.env.BROKER ?? "http://localhost:8787" } as never);
let firstAudioAt = 0, lastAudioAt = 0, spokeSamples = 0, said = "", endedAt = 0, interrupts = 0;
let interruptedAt = 0, audioEvents = 0, audioAtInterrupt = 0;
provider.onEvent((e: { type: string; [k: string]: unknown }) => {
  if (e.type === "assistant_audio") {
    const f = (e.frame as { data: Float32Array; sampleRate: number });
    if (!firstAudioAt) firstAudioAt = Date.now();
    lastAudioAt = Date.now();
    audioEvents++;
    spokeSamples += f.data.length / f.sampleRate;
  } else if (e.type === "assistant_transcript") said = e.final !== false ? (e.text as string) : said + (e.text as string);
  else if (e.type === "interrupted") { interrupts++; if (!interruptedAt) { interruptedAt = Date.now(); audioAtInterrupt = audioEvents; } }
});
await provider.connect({
  language: "ja-JP",
  systemPrompt: `あなたはYui。\n${meetingInstructions({ displayName: "Yui", proactive: true, aliases: ["ゆい"], setting: "one_to_one", canSearch: true })}`,
  privacyMode: "cloud",
  providerOptions: { autoRespond: false },
} as never);

let t = performance.now();
const push = (d: Float32Array) => { provider.pushAudio(createFrame(d, RATE, t)); t += 20; };
const tone = async (ms: number) => { for (let i = 0; i < ms / 20; i++) { push(noise()); await sleep(20); } };
const say = async (path: string, gain = 1) => {
  const f = readWav(path);
  for (let o = 0; o + FRAME <= f.length; o += FRAME) {
    const n = noise(), out = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) out[i] = f[o + i]! * gain + n[i]!;
    push(out); await sleep(20);
  }
  endedAt = Date.now();
};
const turn = async (path: string, waitMs = 9000, gain = 1) => {
  firstAudioAt = 0; lastAudioAt = 0; spokeSamples = 0; said = "";
  await tone(600); await say(path, gain); await tone(waitMs);
  return { latency: firstAudioAt ? firstAudioAt - endedAt : null, seconds: spokeSamples, said, talkedMs: lastAudioAt - firstAudioAt };
};

const rows: string[] = [];
const verdict = (ok: boolean) => (ok ? "PASS" : "FAIL");

// ① silence earns nothing.
firstAudioAt = 0;
await tone(6000);
rows.push(`| ① 勝手に喋らない | ${verdict(!firstAudioAt)} | 6秒の無音に対し発話${firstAudioAt ? "あり" : "なし"} |`);
// The policy's own half of ①: in a meeting she waits to be called.
const meeting = new ParticipationPolicy({ names: ["Yui", "ゆい"], proactivity: "addressed_only" });
meeting.onTranscript({ text: "来週までに資料を作ります", final: true }, 1000);
meeting.tick(5000);
rows.push(`| ① 会議では呼ばれるまで黙る | ${verdict(meeting.state !== "ADDRESSED")} | 呼びかけのない発言のあと state=${meeting.state} |`);

// ②④ speed and length, over three ordinary turns.
const turns = [] as { latency: number | null; seconds: number; said: string }[];
for (const needle of ["昨日の資料、見てくれた", "それって来週までに終わりそう", "ゆイ、今日の予定を教えて"]) {
  const r = await turn(pick(needle));
  turns.push(r);
  console.log(`  ${needle} → ${r.latency ?? "NONE"}ms  ${r.seconds.toFixed(1)}s  ${r.said.slice(0, 60)}`);
}
const lat = turns.map((x) => x.latency).filter((x): x is number => x !== null).sort((a, b) => a - b);
const p50 = lat[Math.floor(lat.length / 2)] ?? null;
rows.push(`| ② 呼んだらすぐ答える | ${verdict(lat.length === turns.length && (p50 ?? 9e9) < 1500)} | ${lat.length}/${turns.length} 応答 · 初音 p50 ${p50}ms |`);
const longest = Math.max(...turns.map((x) => x.seconds));
rows.push(`| ④ 短く自然に喋る | ${verdict(longest <= 12)} | 発話 ${turns.map((x) => x.seconds.toFixed(1)).join(" · ")}秒（上限12秒） |`);

// ③ speech over her reply stops her — measured as the stop, not as the audio already buffered.
{
  firstAudioAt = 0; spokeSamples = 0; interrupts = 0; said = ""; interruptedAt = 0;
  await tone(600); await say(pick("ゆいさんの自己紹介をして"));
  const waitStart = Date.now();
  while (!firstAudioAt && Date.now() - waitStart < 8000) { push(noise()); await sleep(20); }
  await tone(700); // let her get going
  const bargeAt = Date.now();
  await say(pick("ちょっと待って"), 2.5); // somebody talking over her, at a real speaking level
  /**
   * Only the audio that arrives *while they are still talking* counts against her. What comes after
   * is her answer to what they said, which is the point of interrupting.
   */
  const duringBargeIn = interruptedAt ? audioEvents - audioAtInterrupt : Infinity;
  await tone(1200);
  const stoppedIn = interruptedAt ? interruptedAt - bargeAt : null;
  rows.push(`| ③ 人が喋ったら止まる | ${verdict(stoppedIn !== null && stoppedIn < 1200 && duringBargeIn <= 2)} | ${stoppedIn === null ? "停止せず" : `割り込みから ${stoppedIn}ms で停止`} · 相手が話している間に届いた音声 ${duringBargeIn === Infinity ? "—" : duringBargeIn} フレーム |`);
}

// ⑤ a half-heard sentence is asked back rather than filled in. Not a quiet one — a truncated one,
// which is what the recogniser actually delivers: the words are gone, not the volume.
{
  const r = await turn(pick("それっ？"), 9000);
  /**
   * Asking back has a shape, not a phrase: a short reply that ends in a question, or one of the
   * ways a person says they did not catch it. What fails is the confident answer to a sentence
   * nobody actually said — and the bare backchannel (「うん、聞いてるよ。」) that leaves them waiting.
   */
  const asked = (/[?？]/.test(r.said) && r.said.length <= 60)
    || /もう一度|もう一回|聞き取れ|聞こえ|なんて|なんと|ごめん|すみません|よく分から|どうした|何かあった|続き/.test(r.said);
  rows.push(`| ⑤ 聞き取れなければ聞き返す | ${r.said ? verdict(asked) : "INFO"} | ${r.said ? `「${r.said.slice(0, 50)}」` : "応答なし（無音として扱われた）"} |`);
}

const gate = (provider as never as { gateStats: Record<string, number> }).gateStats;
rows.push(`| API に送った音声 | INFO | ${Math.round((100 * gate.sent) / (gate.sent + gate.held))}% （ゲート ${gate.opens}開/${gate.closes}閉/${gate.forced}強制） |`);
console.log(`\n| P0 | 判定 | 実測 |\n|---|---|---|\n${rows.join("\n")}`);
await provider.disconnect();
process.exit(0);
