/**
 * The one-to-one script, without a meeting.
 *
 * The same twelve cues the Tester bot plays in a real room (`scenarios/one-to-one.mjs`), rendered with
 * the system voice, laid over room tone and pushed through the real provider in real time. What it
 * cannot show is the room — Meet's own processing, the vendor's ears, the admission. What it does show
 * is the half nobody could see without a person in a call at the right moment: whether she answers
 * without her name, whether she looks today up instead of inventing it, whether she claims to have
 * read a document nobody sent, and whether she stops when somebody talks over her.
 *
 * Usage: services/agent/node_modules/.bin/tsx scripts/reality/one-to-one-offline.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiLiveProvider } from "../../providers/gemini/src/geminiLiveProvider.js";
import { createFrame } from "../../packages/audio-core/src/types.js";
import { LIVE_LOOKUP_TOOL, meetingInstructions, parseLookupArguments, renderLookup } from "../../packages/meeting-core/src/index.js";
import { lookupLiveInfo } from "../../services/token-broker/src/routes/lookup.js";
import { localClock } from "../../apps/web/src/session/MeetingSessionController.js";
import { oneToOneCues } from "./scenarios/one-to-one.mjs";

const dir = mkdtempSync(join(tmpdir(), "rcai-1on1-"));
const RATE = 16000, FRAME = RATE * 0.02;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The line as sound: the model hears speech, not text, and that is most of what is being tested. */
function render(voice: string, text: string, name: string): Float32Array {
  const aiff = join(dir, `${name}.aiff`), raw = join(dir, `${name}.raw`);
  execFileSync("say", ["-v", voice, "-o", aiff, text]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-ac", "1", "-ar", String(RATE), "-f", "s16le", raw]);
  const b = readFileSync(raw);
  const f = new Float32Array(b.length / 2);
  for (let i = 0; i < f.length; i++) f[i] = b.readInt16LE(i * 2) / 32768;
  return f;
}

const A = process.env.VOICE_A ?? "Kyoko", B = process.env.VOICE_B ?? "Otoya";
const cues = oneToOneCues(A, B) as { id: string; kind: string; text?: string; voice?: string; want?: string; expect: string; cutIn?: { voice: string; text: string }; lines?: [string, string][] }[];

const provider = new GeminiLiveProvider({ brokerUrl: process.env.BROKER ?? "http://localhost:8787" } as never);
let said = "", audioEvents = 0, firstAudioAt = 0, interruptedAt = 0, audioAtInterrupt = 0, spokeSeconds = 0;
const lookups: string[] = [];
provider.onEvent(async (e: { type: string; [k: string]: unknown }) => {
  if (e.type === "assistant_audio") {
    audioEvents++;
    if (!firstAudioAt) firstAudioAt = Date.now();
    const f = e.frame as { data: Float32Array; sampleRate: number };
    spokeSeconds += f.data.length / f.sampleRate;
  } else if (e.type === "assistant_transcript") said = e.final !== false ? (e.text as string) : said + (e.text as string);
  else if (e.type === "interrupted") { if (!interruptedAt) { interruptedAt = Date.now(); audioAtInterrupt = audioEvents; } }
  else if (e.type === "tool_call") {
    const call = e.call as { id: string; name: string; arguments: Record<string, unknown> };
    const req = parseLookupArguments(call.arguments);
    const result = req ? (await lookupLiveInfo(req)).body : { facts: [], at: new Date().toISOString(), error: "bad args" };
    lookups.push(`${req?.kind ?? "?"}:${result.facts.length}`);
    provider.sendToolResponse([{ id: call.id, name: call.name, response: renderLookup(result) }]);
  } else if (e.type === "error") console.log(`  ! ${String((e.error as Error)?.message).slice(0, 120)}`);
});

await provider.connect({
  language: "ja-JP",
  systemPrompt: `あなたはYui。\n${meetingInstructions({ displayName: "Yui", proactive: true, aliases: ["ゆい", "ユイ"], setting: "one_to_one", canSearch: true, now: localClock(new Date()) })}`,
  privacyMode: "cloud",
  tools: [{ ...LIVE_LOOKUP_TOOL, parameters: { ...LIVE_LOOKUP_TOOL.parameters } }],
  providerOptions: { autoRespond: false },
} as never);

let t = performance.now();
const push = (d: Float32Array) => { provider.pushAudio(createFrame(d, RATE, t)); t += 20; };
const noise = () => Float32Array.from({ length: FRAME }, () => (Math.random() * 2 - 1) * 0.01);
const tone = async (ms: number) => { for (let i = 0; i < ms / 20; i++) { push(noise()); await sleep(20); } };
const play = async (pcm: Float32Array, gain = 1) => {
  for (let o = 0; o + FRAME <= pcm.length; o += FRAME) {
    const n = noise(), out = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) out[i] = pcm[o + i]! * gain + n[i]!;
    push(out); await sleep(20);
  }
};

const rows: string[] = [];
for (const cue of cues) {
  said = ""; firstAudioAt = 0; interruptedAt = 0; spokeSeconds = 0;
  const before = audioEvents;
  await tone(700);
  if (cue.kind === "say") await play(render(cue.voice!, cue.text!, cue.id));
  else if (cue.kind === "interrupt") {
    await play(render(cue.voice!, cue.text!, cue.id));
    const deadline = Date.now() + 12000;
    while (!firstAudioAt && Date.now() < deadline) { push(noise()); await sleep(20); }
    await tone(800);
    const bargeAt = Date.now();
    await play(render(cue.cutIn!.voice, cue.cutIn!.text, `${cue.id}-cut`), 2.5);
    const during = interruptedAt ? audioEvents - audioAtInterrupt : Infinity;
    const stoppedIn = interruptedAt ? interruptedAt - bargeAt : null;
    await tone(4000);
    rows.push(`| ${cue.id} | ${cue.expect} | ${stoppedIn !== null && stoppedIn < 1200 && during <= 2 ? "PASS" : "FAIL"} | ${stoppedIn === null ? "停止せず" : `${stoppedIn}msで停止`}・割り込み中の音声${during === Infinity ? "—" : during}フレーム |`);
    continue;
  }
  const endedAt = Date.now();
  await tone(cue.id === "silence" ? 20000 : 11000);
  const spoke = audioEvents > before;
  const latency = firstAudioAt ? firstAudioAt - endedAt : null;
  // The greeting belongs to the page's admission, which does not exist here.
  const verdict = cue.id === "greet" ? "N/A（実会議のみ）" : cue.kind === "listen" || cue.want === "silence" ? (spoke ? "FAIL" : "PASS") : spoke ? "PASS" : "FAIL";
  rows.push(`| ${cue.id} | ${cue.expect} | ${verdict} | ${latency !== null ? `${latency}ms · ${spokeSeconds.toFixed(1)}s · ` : ""}${said ? `「${said.slice(0, 70)}」` : "発話なし"} |`);
  console.log(`  [${cue.id}] ${latency ?? "—"}ms  ${said.slice(0, 80)}`);
}

const gate = (provider as never as { gateStats: Record<string, number> }).gateStats;
console.log(`\n| cue | 期待 | 判定 | 実測 |\n|---|---|---|---|\n${rows.join("\n")}`);
console.log(`\nlookups: ${lookups.join(", ") || "none"} · gate ${gate.opens}開/${gate.closes}閉/${gate.forced}強制/${gate.bargeIns}割り込み · API へ ${Math.round((100 * gate.sent) / (gate.sent + gate.held))}%`);
await provider.disconnect();
process.exit(0);
