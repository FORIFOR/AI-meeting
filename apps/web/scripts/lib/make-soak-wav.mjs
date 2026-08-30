/**
 * Builds a long, loop-safe "fake microphone" WAV for soak tests: N Japanese utterances (macOS `say`),
 * varied statements and questions, a barge-in utterance every ~5th turn (short gap so it lands while the
 * assistant is still speaking), 4–8 s silences in between. 48 kHz / mono / 16-bit PCM.
 *
 * Usage (CLI): node apps/web/scripts/lib/make-soak-wav.mjs --minutes 30 --out /path/mic.wav [--voice Kyoko] [--seed 7]
 * Library:     import { makeSoakWav } from "./make-soak-wav.mjs";
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RATE = 48000;

export const SENTENCES = [
  "こんにちは。今日はよろしくお願いします。",
  "最近、仕事で新しいプロジェクトが始まったんです。",
  "週末は何をするのがおすすめですか？",
  "実は昨日、少し失敗してしまって落ち込んでいます。",
  "でも、チームのみんなが助けてくれました。",
  "あなたは音楽を聴くのは好きですか？",
  "私は最近、ランニングを始めました。",
  "英語の勉強を続けるコツがあれば教えてください。",
  "今日は天気がいいので、散歩に行こうと思います。",
  "面接で緊張しないためには、どうすればいいでしょうか。",
  "先週、友人と京都に旅行に行きました。",
  "そのとき、とても美味しいお茶を飲みました。",
  "あなたの一番好きな季節はいつですか？",
  "来月、新しい部署に異動することになりました。",
  "少し不安ですが、頑張ってみようと思います。",
  "プレゼンの準備で何から始めればいいか迷っています。",
  "昨日の夜は、映画を見て過ごしました。",
  "おすすめの本があれば教えてください。",
  "最近、睡眠時間が短くて疲れやすいです。",
  "コーヒーと紅茶なら、どちらが好きですか？",
  "私は三年前にこの会社に入りました。",
  "今の目標は、チームリーダーになることです。",
  "ところで、あなたは何が得意ですか？",
  "今日はここまでにしましょう。ありがとうございました。",
];

export const BARGE_IN_SENTENCES = ["ちょっと待って、質問があります。", "あ、ごめんなさい、一つ聞いてもいいですか？", "すみません、それはどういう意味ですか？"];

export function synthUtterance(text, voice = "Kyoko", dir = mkdtempSync(join(tmpdir(), "soak-"))) {
  const file = join(dir, `u_${Math.random().toString(36).slice(2)}.wav`);
  execFileSync("say", ["-v", voice, text, `--data-format=LEI16@${RATE}`, "-o", file]);
  const buf = readFileSync(file);
  return parseWav(buf);
}

/** Minimal RIFF parser (handles FLLR/JUNK chunks that `say` inserts). Returns Int16 samples (mono). */
export function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a RIFF file");
  let off = 12;
  let channels = 1;
  let rate = RATE;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
      break;
    }
    off = body + size + (size % 2);
  }
  if (!data) throw new Error("no data chunk");
  let samples = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length - (data.length % 2)));
  if (channels > 1) {
    const mono = new Int16Array(Math.floor(samples.length / channels));
    for (let i = 0; i < mono.length; i++) mono[i] = samples[i * channels];
    samples = mono;
  }
  if (rate !== RATE) throw new Error(`unexpected rate ${rate}`);
  return samples;
}

export function writeWav(path, samples) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length * 2, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Returns { samples, timeline } where timeline lists every utterance with its start second,
 * text and kind ("turn" | "barge_in"), so the soak runner can compute answered-utterance ratio.
 */
export function makeSoakWav({ minutes = 30, voice = "Kyoko", seed = 7, leadSilenceSec = 3, bargeEvery = 5, minGapSec = 4, maxGapSec = 8, bargeGapSec = 2.0 } = {}) {
  const rng = mulberry32(seed);
  const target = Math.round(minutes * 60 * RATE);
  const dir = mkdtempSync(join(tmpdir(), "soak-"));
  const cache = new Map();
  const synth = (text) => {
    if (!cache.has(text)) cache.set(text, synthUtterance(text, voice, dir));
    return cache.get(text);
  };
  const parts = [];
  const timeline = [];
  let pos = Math.round(leadSilenceSec * RATE);
  parts.push(new Int16Array(pos));
  let i = 0;
  let turn = 0;
  while (pos < target) {
    const text = SENTENCES[i % SENTENCES.length];
    const u = synth(text);
    if (pos + u.length > target) break;
    timeline.push({ index: turn, startSec: pos / RATE, endSec: (pos + u.length) / RATE, text, kind: "turn" });
    parts.push(u);
    pos += u.length;
    turn++;
    i++;
    const bargeNow = turn % bargeEvery === 0;
    if (bargeNow) {
      const gap = Math.round(bargeGapSec * RATE);
      parts.push(new Int16Array(gap));
      pos += gap;
      const btext = BARGE_IN_SENTENCES[turn % BARGE_IN_SENTENCES.length];
      const b = synth(btext);
      if (pos + b.length > target) break;
      timeline.push({ index: turn, startSec: pos / RATE, endSec: (pos + b.length) / RATE, text: btext, kind: "barge_in" });
      parts.push(b);
      pos += b.length;
      turn++;
    }
    const gapSec = minGapSec + rng() * (maxGapSec - minGapSec);
    const gap = Math.round(gapSec * RATE);
    parts.push(new Int16Array(gap));
    pos += gap;
  }
  // Loop-safe: end with the tail gap already appended; lead silence is at the start.
  const total = parts.reduce((a, p) => a + p.length, 0);
  const samples = new Int16Array(total);
  let off = 0;
  for (const p of parts) {
    samples.set(p, off);
    off += p.length;
  }
  return { samples, timeline, seconds: total / RATE };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? "true"] : null)).filter(Boolean));
  const minutes = Number(args.minutes ?? 30);
  const out = args.out ?? `soak-${minutes}m.wav`;
  const { samples, timeline, seconds } = makeSoakWav({ minutes, voice: args.voice ?? "Kyoko", seed: Number(args.seed ?? 7) });
  writeWav(out, samples);
  writeFileSync(out.replace(/\.wav$/, ".timeline.json"), JSON.stringify({ seconds, timeline }, null, 2));
  console.log(`wrote ${out}: ${seconds.toFixed(1)} s, ${timeline.length} utterances (${timeline.filter((t) => t.kind === "barge_in").length} barge-ins)`);
}
