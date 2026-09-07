/**
 * The same lines, in three voices, for a blind listen.
 *
 * Usage: services/agent/node_modules/.bin/tsx scripts/reality/voice-samples.ts <out-dir> [voice ...]
 *
 * A voice is not chosen from a vendor's adjective. It is chosen by hearing the character say the
 * things it will actually say — a greeting, an answer, a correction, a refusal — and noticing which
 * one you would still want to hear in half an hour. Files come out as A/B/C with a key written last,
 * so the listening is blind unless you go looking.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { GeminiLiveProvider } from "../../providers/gemini/src/geminiLiveProvider.js";
import { GEMINI_LIVE_VOICES_TO_COMPARE } from "../../providers/gemini/src/protocol.js";

const LINES = [
  "はじめまして、Yuiです。今日はよろしくね。",
  "今日の東京は強い雨が降る予報だよ。最高でも24度だって。お出かけするなら雨具が必須だね。",
  "ごめん、その資料はまだ共有されてないから見られてないんだ。送ってもらえる？",
  "ニュースだと、伊豆諸島の方で大雨の警戒レベルが出てるみたい。気になる話題ある？",
  "あ、ごめん。どうぞ、先に話して。",
];

const outDir = process.argv[2] ?? "voice-samples";
const voices = process.argv.length > 3 ? process.argv.slice(3) : [...GEMINI_LIVE_VOICES_TO_COMPARE];
mkdirSync(outDir, { recursive: true });

/** 24 kHz mono PCM16, the rate Gemini speaks at, wrapped so anything can play it. */
function wav(pcm: Buffer, rate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const key: string[] = [];
const label = "ABCDEFGH";
for (let i = 0; i < voices.length; i++) {
  const voice = voices[i]!;
  const p = new GeminiLiveProvider({ brokerUrl: process.env.BROKER ?? "http://localhost:8787", defaultVoice: voice, googleSearch: false } as never);
  const chunks: Buffer[] = [];
  p.onEvent((e: { type: string; [k: string]: unknown }) => {
    if (e.type === "assistant_audio") {
      const f = (e.frame as { data: Float32Array; sampleRate: number }).data;
      const b = Buffer.alloc(f.length * 2);
      for (let j = 0; j < f.length; j++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f[j]! * 32767))), j * 2);
      chunks.push(b);
    } else if (e.type === "error") console.log(`  ! ${voice}: ${String((e.error as Error)?.message).slice(0, 120)}`);
  });
  await p.connect({
    language: "ja-JP",
    // The persona is half the voice: the same speaker sounds like a different character reading a
    // script written for someone else.
    systemPrompt: "あなたはYui。親しみやすく落ち着いた話し方の日本語AI。渡された文をそのまま自然に読み上げる。付け足さない。",
    privacyMode: "cloud",
    providerOptions: { autoRespond: false },
  } as never);
  for (const line of LINES) {
    await p.sendText(`次の文だけを、そのまま自然に読み上げて: 「${line}」`);
    await new Promise((r) => setTimeout(r, 9000));
  }
  await p.disconnect();
  const name = `voice_${label[i]}.wav`;
  writeFileSync(`${outDir}/${name}`, wav(Buffer.concat(chunks), 48000));
  key.push(`${label[i]} = ${voice}`);
  console.log(`${name}  ${(Buffer.concat(chunks).length / 96000).toFixed(1)}s`);
}
writeFileSync(`${outDir}/KEY.txt`, `${key.join("\n")}\n\n聞くときの観点:\n① このキャラクターに合っている\n② 日本語が自然\n③ 親しみを感じる\n④ 仕事でも使いたい\n⑤ 30分聞いても疲れなさそう\n⑥ また話しかけたい\n`);
console.log(`\nkey written to ${outDir}/KEY.txt (open it after listening)`);
process.exit(0);
