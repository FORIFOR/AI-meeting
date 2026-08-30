/**
 * Gate 6 end-to-end evidence: strict_local conversation through the WS local bus.
 * Usage: pnpm --filter @rcai/agent exec tsx scripts/e2e-local.ts   (agent must be running on :8788 with RCAI_EGRESS_LOG=1)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { parseWav } from "../src/wav.js";
import { decodeAudioFrame } from "../src/protocol.js";

const AGENT = process.env.AGENT_URL ?? "http://127.0.0.1:8788";
const WS_URL = AGENT.replace(/^http/, "ws") + "/session";

function say16(text: string): Int16Array {
  const file = path.join(os.tmpdir(), `rcai-e2e-${Date.now()}.wav`);
  execFileSync("say", ["-v", "Kyoko", "--data-format=LEI16@16000", "-o", file, text]);
  const wav = parseWav(new Uint8Array(fs.readFileSync(file)));
  fs.unlinkSync(file);
  return wav.pcm16;
}

interface Ev { type: string; text?: string; final?: boolean; message?: string; turn?: Record<string, unknown>; at: number }
const TURNS = Number(process.env.E2E_TURNS ?? 3);
const allMetrics: Record<string, unknown>[] = [];
const clientTurns: { firstAudioMs: number; transcriptMs: number }[] = [];
function pct(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

async function main() {
  const health = await (await fetch(`${AGENT}/health`)).json();
  console.log("health:", JSON.stringify(health));
  await fetch(`${AGENT}/egress`, { method: "DELETE" });

  const ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";
  const events: Ev[] = [];
  const audio: { at: number; sampleRate: number; samples: number }[] = [];
  let audioMs = 0;
  ws.on("message", (data, isBinary) => {
    const at = Date.now();
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const f = decodeAudioFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      audio.push({ at, sampleRate: f.sampleRate, samples: f.pcm16.length });
      audioMs += (f.pcm16.length / f.sampleRate) * 1000;
    } else {
      const j = JSON.parse(data.toString());
      events.push({ ...j, at });
      if (j.type === "metrics") { allMetrics.push(j.turn); console.log(`  ev metrics ${JSON.stringify(j.turn)}`); }
      else console.log(`  ev ${j.type}${j.text ? ` "${j.text}"` : ""}${j.message ? ` ${j.message}` : ""}`);
    }
  });
  await new Promise<void>((r) => ws.on("open", () => r()));
  ws.send(JSON.stringify({ type: "start", config: { systemPrompt: "あなたの名前は「Yui」です。友達のように話し言葉で、1〜2文で短く返答してください。質問は一度に一つ。", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local" } }));
  await waitFor(() => events.some((e) => e.type === "ready"), 5000, "ready");

  const stream = async (pcm: Int16Array, tailSilenceMs = 900) => {
    const chunk = 320; // 20 ms
    for (let off = 0; off < pcm.length; off += chunk) {
      const part = pcm.subarray(off, Math.min(pcm.length, off + chunk));
      ws.send(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
      await sleep(20);
    }
    const silent = new Int16Array(chunk);
    for (let t = 0; t < tailSilenceMs; t += 20) { ws.send(Buffer.from(silent.buffer)); await sleep(20); }
  };

  // ---- Turn 1
  console.log("turn 1: streaming speech");
  const t1 = Date.now();
  await stream(say16("こんにちは、今日はいい天気ですね"));
  await waitFor(() => events.some((e) => e.type === "assistant_speech_ended"), 60000, "assistant_speech_ended");
  const started = events.find((e) => e.type === "user_speech_started")!;
  const ended = events.find((e) => e.type === "user_speech_ended")!;
  const utt = events.find((e) => e.type === "user_transcript")!;
  const firstAudio = audio[0]!;
  const speechStarted = events.find((e) => e.type === "assistant_speech_started")!;
  const reply = events.filter((e) => e.type === "assistant_transcript" && e.final).map((e) => e.text).join("");
  assert(started && ended, "user speech events");
  assert(/(こんにちは|天気)/.test(utt.text ?? ""), `transcript "${utt.text}"`);
  assert(audio.length > 0 && audioMs > 300, `audio ${audio.length} chunks / ${audioMs.toFixed(0)}ms`);
  const results = {
    turn1: {
      transcript: utt.text,
      reply,
      audioChunks: audio.length,
      audioMs: Math.round(audioMs),
      sampleRate: firstAudio.sampleRate,
      userSpeechEnd_to_firstAudio_ms: firstAudio.at - ended.at,
      userSpeechEnd_to_transcript_ms: utt.at - ended.at,
      userSpeechEnd_to_speechStarted_ms: speechStarted.at - ended.at,
      total_ms: Date.now() - t1,
    },
  } as Record<string, unknown>;
  console.log("turn 1 result:", JSON.stringify(results.turn1));
  clientTurns.push({ firstAudioMs: firstAudio.at - ended.at, transcriptMs: utt.at - ended.at });

  // ---- Warm turns (breakdown statistics)
  const prompts = ["最近ハマっている趣味はありますか", "おすすめの映画を一つ教えてください", "週末は何をして過ごすのが好きですか", "コーヒーと紅茶ならどちらが好きですか", "明日の予定を一緒に考えてもらえますか"];
  for (let i = 1; i < TURNS; i++) {
    events.length = 0; audio.length = 0; audioMs = 0;
    console.log(`warm turn ${i + 1}: "${prompts[(i - 1) % prompts.length]}"`);
    await stream(say16(prompts[(i - 1) % prompts.length]!));
    await waitFor(() => events.some((e) => e.type === "assistant_speech_ended"), 60000, "assistant_speech_ended");
    const e2 = events.find((e) => e.type === "user_speech_ended")!;
    const u2 = events.find((e) => e.type === "user_transcript")!;
    const a2 = audio[0]!;
    clientTurns.push({ firstAudioMs: a2.at - e2.at, transcriptMs: u2.at - e2.at });
    console.log(`  warm turn ${i + 1}: speech_end→first audio ${a2.at - e2.at} ms, transcript "${u2.text}"`);
  }

  // ---- Turn 2 + barge-in
  events.length = 0; audio.length = 0; audioMs = 0;
  console.log("turn 2: ask a longer question, then barge in while the assistant speaks");
  await stream(say16("あなたの好きな季節と、その理由を三つ教えてください"));
  await waitFor(() => audio.length > 3, 60000, "assistant audio streaming");
  const bargeAt = Date.now();
  const audioBefore = audio.length;
  const bargeStream = stream(say16("ちょっと待って"), 700);
  await waitFor(() => events.some((e) => e.type === "interrupted" && e.at >= bargeAt), 5000, "interrupted");
  const interrupted = events.find((e) => e.type === "interrupted" && e.at >= bargeAt)!;
  const speechStart2 = events.find((e) => e.type === "user_speech_started" && e.at >= bargeAt)!;
  const chunksAfterInterrupt = audio.filter((a) => a.at > interrupted.at + 50).length;
  await bargeStream;
  await sleep(1500);
  const lateChunks = audio.filter((a) => a.at > interrupted.at + 50).length;
  const uttsAfter = events.filter((e) => e.type === "user_transcript" && e.at >= bargeAt).map((e) => e.text);
  results.bargeIn = {
    audioChunksBeforeBargeIn: audioBefore,
    speechStart_to_interrupted_ms: interrupted.at - speechStart2.at,
    bargeSend_to_interrupted_ms: interrupted.at - bargeAt,
    audioChunksAfterInterrupt: chunksAfterInterrupt,
    audioChunksWithin1500msAfterInterrupt_excludingNewReply: lateChunks,
    transcriptsAfterBargeIn: uttsAfter,
  };
  console.log("barge-in result:", JSON.stringify(results.bargeIn));
  assert(interrupted.at - speechStart2.at <= 300, "interrupted within 300 ms of speech start");
  assert(chunksAfterInterrupt === 0 || events.some((e) => e.type === "assistant_speech_started" && e.at > interrupted.at), "no stale audio after interrupt");

  // ---- Text path
  events.length = 0; audio.length = 0; audioMs = 0;
  ws.send(JSON.stringify({ type: "text", text: "ありがとう、またね" }));
  await waitFor(() => events.some((e) => e.type === "assistant_speech_ended"), 60000, "text reply");
  results.textTurn = { reply: events.filter((e) => e.type === "assistant_transcript" && e.final).map((e) => e.text).join(""), audioMs: Math.round(audioMs) };
  console.log("text turn:", JSON.stringify(results.textTurn));

  ws.send(JSON.stringify({ type: "stop" }));
  ws.close();

  // ---- /plan and /evaluate
  const plan = await (await fetch(`${AGENT}/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ speaker: "assistant", text: "すごく良い視点だと思います。", mode: "english_lesson" }) })).json();
  console.log("/plan:", JSON.stringify(plan));
  const evalIn = {
    mode: "interview", language: "ja-JP",
    transcript: [
      { role: "assistant", text: "自己紹介をお願いします。" },
      { role: "user", text: "はい、私はバックエンドエンジニアとして三年間、決済システムの開発を担当してきました。特にレイテンシ改善で、平均応答時間を四十パーセント削減した経験があります。" },
      { role: "assistant", text: "ありがとうございます。その改善で一番難しかった点は何でしたか？" },
      { role: "user", text: "えっと、既存のコードを壊さずに変更する点です。段階的にリリースして、まず計測から始めました。" },
    ],
    timing: { responseLatenciesMs: [800, 950], userSilencesMs: [1200, 900], userSpeechDurationsMs: [9000, 6000], assistantSpeechDurationsMs: [2000, 3000] },
    interruptions: { byUser: 0, byAssistant: 0 },
  };
  const t3 = Date.now();
  const ev = await (await fetch(`${AGENT}/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(evalIn) })).json();
  console.log(`/evaluate (${Date.now() - t3}ms):`, JSON.stringify(ev));
  results.plan = plan; results.evaluate = ev;

  const egress = await (await fetch(`${AGENT}/egress`)).json();
  results.egress = egress;
  console.log("egress log:", JSON.stringify(egress));
  assert((egress.entries as unknown[]).length === 0, "no non-loopback egress");

  // ---- Breakdown table (agent-side TurnMetrics + client-observed)
  const fields = ["vadEndMs", "sttMs", "llmTtftMs", "firstPhraseMs", "ttsTtfaMs", "firstAudioSentMs", "totalMs"] as const;
  const speechTurns = allMetrics.filter((m) => m.source === "speech");
  const breakdown: Record<string, { n: number; p50: number; p95: number }> = {};
  console.log("\nlatency breakdown (agent, speech turns):");
  console.log("  stage               n   p50    p95");
  for (const f of fields) {
    const v = speechTurns.map((m) => m[f]).filter((x): x is number => typeof x === "number");
    breakdown[f] = { n: v.length, p50: pct(v, 50), p95: pct(v, 95) };
    console.log(`  ${f.padEnd(18)} ${String(v.length).padStart(2)} ${String(Math.round(pct(v, 50))).padStart(6)} ${String(Math.round(pct(v, 95))).padStart(6)}`);
  }
  const cf = clientTurns.map((t) => t.firstAudioMs);
  breakdown.client_speechEnd_to_firstAudio = { n: cf.length, p50: pct(cf, 50), p95: pct(cf, 95) };
  console.log(`  ${"client→firstAudio".padEnd(18)} ${String(cf.length).padStart(2)} ${String(Math.round(pct(cf, 50))).padStart(6)} ${String(Math.round(pct(cf, 95))).padStart(6)}`);
  results.breakdown = breakdown;
  results.turns = allMetrics;
  results.engines = speechTurns[0]?.engines;
  fs.writeFileSync(path.join(process.cwd(), "scripts/e2e-local.result.json"), JSON.stringify(results, null, 2));
  console.log("E2E PASS");
  process.exit(0);
}

function assert(cond: unknown, what: string) {
  if (!cond) { console.error("ASSERT FAILED:", what); process.exit(1); }
  console.log("  ok:", what);
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(pred: () => boolean, timeoutMs: number, what: string) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > timeoutMs) { console.error("TIMEOUT waiting for", what); process.exit(1); } await sleep(10); }
}
main().catch((e) => { console.error(e); process.exit(1); });
