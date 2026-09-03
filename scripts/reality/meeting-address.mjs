/**
 * Meeting reality gate without Recall: does the character notice it was addressed, and answer out loud?
 *
 * The full path (Recall → in-bot transcript socket → page) needs a live bot, and bots cost credits. What
 * that transport ultimately delivers is a transcript segment, so this feeds the real
 * `ParticipationPolicy` real transcript segments and runs whatever it decides through the real agent:
 * address detection → ADDRESSED → answer → LLM → TTS → audio frames.
 *
 *   pnpm reality:address
 *
 * What this does NOT cover: Recall's own delivery of those segments in a live call. That still needs a
 * meeting and a bot with credit on it — see docs/acceptance-gates.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// Run the real policy from source; the package ships TypeScript, so tsx provides the loader.
import { MEETING_PERSONA_ID, ParticipationPolicy, meetingInstructions, meetingTurnPrompt } from "../../packages/meeting-core/src/index.js";
import { buildSystemPrompt } from "../../packages/persona-core/src/index.js";
import { personas } from "../../personas/src/catalog.js";

const WebSocket = createRequire(new URL("../../services/agent/package.json", import.meta.url))("ws");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const AGENT = process.env.AGENT_URL ?? "ws://127.0.0.1:8788/session";
const NAMES = (process.env.CHARACTER_NAMES ?? "Yui,ゆい,ユイ,結衣").split(",");
/**
 * As they would arrive from the meeting. The character deliberately does not answer twice in a row
 * without someone else speaking (maxConsecutiveResponses) and holds a short cooldown after answering,
 * so a fair script talks the way a meeting does: chatter between the questions it is asked.
 */
const SCRIPT = [
  { by: "shuhei", text: "では、今日の議題を確認しましょう。", expect: "ignored" },
  { by: "shuhei", text: "先週の数字はだいたい想定どおりでした。", expect: "ignored" },
  { by: "shuhei", text: "ゆいさん、聞こえていますか。", expect: "answered" },
  { by: "kenji", text: "そのあたりは私も同じ認識です。", expect: "ignored" },
  { by: "shuhei", text: "ゆいさん、今日の会議の進め方についてどう思いますか。", expect: "answered" },
  { by: "kenji", text: "ゆいがそう言ってた気がする。", expect: "ignored" },
  { by: "shuhei", text: "ゆいさん、来週までにやることを教えてください。", expect: "answered" },
];

const rows = [];
const row = (step, status, detail) => rows.push({ step, status, detail });
const policy = new ParticipationPolicy({ names: NAMES, proactivity: "addressed_only" });
const transitions = [];
policy.onTransition?.((t) => transitions.push(t));

const audio = [];
let outRate = 24000;
const replies = [];
let pending = null;

const ws = new WebSocket(AGENT);
const send = (o) => ws.send(JSON.stringify(o));

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    outRate = b.readUInt32LE(0);
    audio.push(b.subarray(12));
    return;
  }
  const m = JSON.parse(data.toString());
  if (m.type === "assistant_transcript" && m.final) {
    replies.push({ text: m.text, at: Date.now() });
    if (pending) { pending.resolve(m.text); pending = null; }
  }
});

const waitReply = (ms) => new Promise((resolve) => {
  const t = setTimeout(() => { pending = null; resolve(null); }, ms);
  pending = { resolve: (v) => { clearTimeout(t); resolve(v); } };
});

await new Promise((r) => ws.on("open", r));
// The character the bot page sends into a meeting: the meeting persona with the meeting instructions,
// and each address rendered with the room's lines before it — the same text, so the reply measured
// here is the one the room would hear.
const persona = personas.find((p) => p.id === (process.env.PERSONA ?? MEETING_PERSONA_ID));
if (!persona) throw new Error(`unknown persona ${process.env.PERSONA}`);
const manifest = JSON.parse(readFileSync(join(root, "characters", process.env.CHARACTER ?? "yui", "manifest.json"), "utf8"));
send({ type: "start", config: {
  systemPrompt: buildSystemPrompt({ persona, character: { manifest }, params: {}, extra: meetingInstructions({ displayName: NAMES[0], proactive: false }) }),
  mode: persona.mode, language: persona.language, privacyMode: "default", characterId: manifest.id, personaId: persona.id,
  providerOptions: { speakingStyle: persona.speakingStyle, turnPolicy: persona.turnPolicy },
}});
await new Promise((r) => setTimeout(r, 800));

let correct = 0;
const heard = []; // the room so far, "speaker: text", as the bot page keeps it
for (const line of SCRIPT) {
  const before = policy.state;
  policy.onTranscript({ text: line.text, final: true, speakerName: line.by }, Date.now());
  const addressed = before !== "ADDRESSED" && policy.state === "ADDRESSED";
  const asExpected = addressed === (line.expect === "answered");
  if (asExpected) correct++;
  console.log(`${asExpected ? "✓" : "✗"} [${line.expect.padEnd(8)}] ${line.text}${addressed ? "  → ADDRESSED" : ""}`);
  if (!addressed) { heard.push(`${line.by}: ${line.text}`); continue; }
  const t0 = Date.now();
  send({ type: "text", text: meetingTurnPrompt({ context: heard.slice(-12), asked: { speakerName: line.by, text: policy.addressedBy?.text ?? line.text } }) });
  heard.push(`${line.by}: ${line.text}`);
  const reply = await waitReply(30000);
  console.log(`     Yui: ${reply ?? "(応答なし)"}${reply ? `  (+${Date.now() - t0}ms)` : ""}`);
  policy.onAssistantDone(Date.now());
  await new Promise((r) => setTimeout(r, 5000)); // longer than the policy cooldown
}

await new Promise((r) => setTimeout(r, 2500));
const pcmBytes = audio.reduce((n, b) => n + b.length, 0);
const seconds = pcmBytes / 2 / outRate;
let peak = 0;
for (const b of audio) for (let i = 0; i + 1 < b.length; i += 64) peak = Math.max(peak, Math.abs(b.readInt16LE(i)));

const dir = mkdtempSync(join(tmpdir(), "rcai-address-"));
const wav = join(dir, "yui.wav");
const body = Buffer.concat(audio);
const h = Buffer.alloc(44);
h.write("RIFF", 0); h.writeUInt32LE(36 + body.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(outRate, 24);
h.writeUInt32LE(outRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36);
h.writeUInt32LE(body.length, 40);
writeFileSync(wav, Buffer.concat([h, body]));

const wanted = SCRIPT.filter((s) => s.expect === "answered").length;
row(`address detection (${SCRIPT.length} lines, ${wanted} addressed)`, correct === SCRIPT.length ? "PASS" : "FAIL", `${correct}/${SCRIPT.length} classified correctly`);
row("answered when addressed", replies.length >= wanted ? "PASS" : "FAIL", `${replies.length}/${wanted} replies`);
row("spoke (audio frames)", seconds > 1 ? "PASS" : "FAIL", `${seconds.toFixed(1)}s @ ${outRate}Hz, peak ${(peak / 32768 * 100).toFixed(0)}%`);
row("stayed quiet otherwise", replies.length === wanted ? "PASS" : "FAIL", `${replies.length} replies for ${wanted} addresses`);
row("reply audio", "INFO", wav);
console.log("\n| step | status | detail |\n|---|---|---|");
for (const r of rows) console.log(`| ${r.step} | ${r.status} | ${r.detail} |`);
ws.close();
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : 0);
