/**
 * Round 3 Gate 1 — 100 consecutive barge-ins against a running local agent (protocol v2).
 * Usage: AGENT_URL=http://127.0.0.1:8791 ITER=100 pnpm --filter @rcai/agent exec tsx scripts/stress-bargein.ts
 * PASS: stale audio 0 / stale caption 0 / stale speaking state 0 (all judged by generationId after `interrupted`).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { parseWav } from "../src/wav.js";
import { decodeAudioFrame } from "../src/protocol.js";

const AGENT = process.env.AGENT_URL ?? "http://127.0.0.1:8791";
const ITER = Number(process.env.ITER ?? 100);
const WINDOW_MS = Number(process.env.STALE_WINDOW_MS ?? 1500);
const OUT = process.env.OUT ?? path.resolve(process.cwd(), "scripts/stress-bargein.result.json");

function say16(text: string): Int16Array {
  const file = path.join(os.tmpdir(), `rcai-stress-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  execFileSync("say", ["-v", "Kyoko", "--data-format=LEI16@16000", "-o", file, text]);
  const wav = parseWav(new Uint8Array(fs.readFileSync(file)));
  fs.unlinkSync(file);
  return wav.pcm16;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}
function pct(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

interface Ev { type: string; text?: string; final?: boolean; gen?: { turnId: number; generationId: number; sequence: number }; at: number }
interface Au { at: number; generationId: number; sequence: number; samples: number }

async function main() {
  const health = await (await fetch(`${AGENT}/health`)).json();
  console.log("health:", JSON.stringify(health));
  const prompts = ["あなたの好きな季節と、その理由を三つ教えてください", "週末の過ごし方について詳しく話してください", "おすすめの本を三冊、理由つきで紹介してください", "最近の天気について長めに感想を聞かせてください"];
  const promptWavs = prompts.map(say16);
  const bargeWav = say16("ちょっと待って、質問があります");

  const ws = new WebSocket(AGENT.replace(/^http/, "ws") + "/session");
  ws.binaryType = "arraybuffer";
  const events: Ev[] = [];
  const audio: Au[] = [];
  ws.on("message", (data, isBinary) => {
    const at = Date.now();
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const f = decodeAudioFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      audio.push({ at, generationId: f.generationId, sequence: f.sequence, samples: f.pcm16.length });
    } else {
      events.push({ ...(JSON.parse(data.toString()) as Omit<Ev, "at">), at });
    }
  });
  await new Promise<void>((r) => ws.on("open", () => r()));
  ws.send(JSON.stringify({ type: "start", config: { systemPrompt: "あなたの名前は「Yui」です。話し言葉で、必ず3〜4文でしっかり答えてください。", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local" } }));
  await waitFor(() => events.some((e) => e.type === "ready"), 5000, "ready");
  const ready = events.find((e) => e.type === "ready") as Ev & { protocolVersion?: number };
  console.log("protocolVersion:", ready.protocolVersion);

  const stream = async (pcm: Int16Array, tailSilenceMs = 700) => {
    const chunk = 320;
    for (let off = 0; off < pcm.length; off += chunk) {
      const part = pcm.subarray(off, Math.min(pcm.length, off + chunk));
      ws.send(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
      await sleep(20);
    }
    const silent = new Int16Array(chunk);
    for (let t = 0; t < tailSilenceMs; t += 20) { ws.send(Buffer.from(silent.buffer)); await sleep(20); }
  };

  const rows: Record<string, number>[] = [];
  let totalStaleAudio = 0, totalStaleCaption = 0, totalStaleSpeaking = 0, totalStaleEnded = 0, failures = 0;
  const interruptLat: number[] = [];
  const firstAudioLat: number[] = [];
  for (let i = 0; i < ITER; i++) {
    events.length = 0; audio.length = 0;
    const t0 = Date.now();
    try {
      await stream(promptWavs[i % promptWavs.length]!);
      const endedEv = events.find((e) => e.type === "user_speech_ended");
      await waitFor(() => audio.length >= 3, 30000, "assistant audio");
      const gen = audio[0]!.generationId;
      firstAudioLat.push(audio[0]!.at - (endedEv?.at ?? t0));
      // Barge in while the assistant is speaking.
      const bargeAt = Date.now();
      const bargeStream = stream(bargeWav, 700);
      await waitFor(() => events.some((e) => e.type === "interrupted" && e.at >= bargeAt), 8000, "interrupted");
      const intr = events.find((e) => e.type === "interrupted" && e.at >= bargeAt)!;
      const speechStart = events.find((e) => e.type === "user_speech_started" && e.at >= bargeAt);
      interruptLat.push(intr.at - (speechStart?.at ?? bargeAt));
      if (intr.gen && intr.gen.generationId !== gen) console.log(`  [${i}] warn: interrupted gen ${intr.gen.generationId} != audio gen ${gen}`);
      await bargeStream;
      await sleep(Math.max(0, WINDOW_MS - (Date.now() - intr.at)));
      // Anything of the OLD generation after `interrupted` is a late chunk.
      const staleAudio = audio.filter((a) => a.at > intr.at && a.generationId === gen).length;
      const staleCaption = events.filter((e) => e.type === "assistant_transcript" && e.at > intr.at && e.gen?.generationId === gen).length;
      const staleSpeaking = events.filter((e) => e.type === "assistant_speech_started" && e.at > intr.at && e.gen?.generationId === gen).length;
      const staleEnded = events.filter((e) => e.type === "assistant_speech_ended" && e.at > intr.at && e.gen?.generationId === gen).length;
      const unstamped = audio.filter((a) => a.at > intr.at && a.generationId === 0).length + events.filter((e) => e.at > intr.at && /^assistant_/.test(e.type) && !e.gen).length;
      totalStaleAudio += staleAudio; totalStaleCaption += staleCaption; totalStaleSpeaking += staleSpeaking; totalStaleEnded += staleEnded;
      rows.push({ i, gen, staleAudio, staleCaption, staleSpeaking, staleEnded, unstamped, interruptMs: interruptLat.at(-1)!, firstAudioMs: firstAudioLat.at(-1)! });
      if (i % 10 === 0 || staleAudio || staleCaption || staleSpeaking) console.log(`  [${i}] gen=${gen} stale audio/caption/speaking/ended=${staleAudio}/${staleCaption}/${staleSpeaking}/${staleEnded} interrupt ${interruptLat.at(-1)}ms firstAudio ${firstAudioLat.at(-1)}ms`);
      // Cancel the reply to the barge-in utterance and wait for quiet before the next iteration.
      // Under load the reply to the barge utterance may only start seconds later (STT/LLM queueing):
      // re-cancel whenever new audio shows up so the next iteration starts from silence.
      ws.send(JSON.stringify({ type: "interrupt" }));
      await sleep(400);
      let quietSince = Date.now();
      let lastCancelAt = Date.now();
      await waitFor(() => {
        const last = audio.at(-1)?.at ?? 0;
        if (last > quietSince) {
          quietSince = last;
          if (Date.now() - lastCancelAt > 500) { ws.send(JSON.stringify({ type: "interrupt" })); lastCancelAt = Date.now(); }
        }
        return Date.now() - quietSince > 600 && Date.now() - lastCancelAt > 600;
      }, 40000, "quiet");
    } catch (err) {
      failures++;
      console.log(`  [${i}] FAIL ${(err as Error).message}`);
      ws.send(JSON.stringify({ type: "interrupt" }));
      await sleep(1500);
    }
  }
  ws.send(JSON.stringify({ type: "stop" }));
  ws.close();
  const egress = await (await fetch(`${AGENT}/egress`)).json().catch(() => null);
  const summary = {
    agent: AGENT, iterations: ITER, completed: rows.length, failures, windowMs: WINDOW_MS,
    staleAudio: totalStaleAudio, staleCaption: totalStaleCaption, staleSpeaking: totalStaleSpeaking, staleSpeechEnded: totalStaleEnded,
    unstampedAfterInterrupt: rows.reduce((a, r) => a + r.unstamped!, 0),
    interruptMs: { p50: pct(interruptLat, 50), p95: pct(interruptLat, 95), max: Math.max(...interruptLat) },
    speechEndToFirstAudioMs: { p50: pct(firstAudioLat, 50), p95: pct(firstAudioLat, 95) },
    egress,
    pass: failures === 0 && totalStaleAudio === 0 && totalStaleCaption === 0 && totalStaleSpeaking === 0 && totalStaleEnded === 0 && rows.length === ITER,
  };
  fs.writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
  console.log("\n| check | value | PASS |\n|---|---|---|");
  console.log(`| iterations completed | ${rows.length}/${ITER} | ${rows.length === ITER ? "✓" : "✗"} |`);
  console.log(`| stale audio chunks after interrupted | ${totalStaleAudio} | ${totalStaleAudio === 0 ? "✓" : "✗"} |`);
  console.log(`| stale captions after interrupted | ${totalStaleCaption} | ${totalStaleCaption === 0 ? "✓" : "✗"} |`);
  console.log(`| stale speaking state (speech_started of old gen) | ${totalStaleSpeaking} | ${totalStaleSpeaking === 0 ? "✓" : "✗"} |`);
  console.log(`| stale speech_ended of old gen | ${totalStaleEnded} | ${totalStaleEnded === 0 ? "✓" : "✗"} |`);
  console.log(`| interrupt latency p50 / p95 / max | ${summary.interruptMs.p50} / ${summary.interruptMs.p95} / ${summary.interruptMs.max} ms | |`);
  console.log(`| speech_end → first audio p50 / p95 | ${summary.speechEndToFirstAudioMs.p50} / ${summary.speechEndToFirstAudioMs.p95} ms | |`);
  console.log(`| egress | ${JSON.stringify(egress)} | |`);
  console.log(`\nRESULT: ${summary.pass ? "PASS" : "FAIL"} (${OUT})`);
  process.exit(summary.pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
