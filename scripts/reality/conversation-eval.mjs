/**
 * Conversation-quality gate — is the character good company, not just fast?
 *
 * Plays one coherent chat (a story arc with callbacks to earlier details) into services/agent as text,
 * waits for each spoken reply to finish before the next line — the way a person does — and scores the
 * transcript for the things that make a conversation rich: how much the character says, whether it asks,
 * whether it remembers what it was told ten turns ago, whether it brings something of its own, and whether
 * it keeps starting sentences the same way.
 *
 *   pnpm reality:conversation                      # friend_ja persona, Yui, local agent on 8788
 *   PERSONA=companion_ja pnpm reality:conversation
 *   SCENARIO=scripts/reality/scenarios/x.json pnpm reality:conversation
 *
 * The same numbers before and after a persona/prompt/history change tell you whether it helped.
 * Needs the agent running (any LLM/TTS it is configured with is what gets measured).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { buildSystemPrompt } from "../../packages/persona-core/src/index.js";
import { personas } from "../../personas/src/catalog.js";

const WebSocket = createRequire(new URL("../../services/agent/package.json", import.meta.url))("ws");
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const AGENT = process.env.AGENT_URL ?? "ws://127.0.0.1:8788/session";
const PERSONA = process.env.PERSONA ?? "friend_ja";
const CHARACTER = process.env.CHARACTER ?? "yui";
const VOICE = process.env.VOICE; // agent default when unset
const SCENARIO = resolve(process.env.SCENARIO ?? join(here, "scenarios/friend-evening.json"));
const OUT = resolve(process.env.OUT ?? "docs/reports/conversation");
const REPLY_TIMEOUT_MS = Number(process.env.REPLY_TIMEOUT_MS ?? 25_000);
const LISTEN_PAUSE_MS = Number(process.env.LISTEN_PAUSE_MS ?? 1200);

const persona = personas.find((p) => p.id === PERSONA);
if (!persona) throw new Error(`unknown persona ${PERSONA} (${personas.map((p) => p.id).join(", ")})`);
const manifest = JSON.parse(readFileSync(join(root, "characters", CHARACTER, "manifest.json"), "utf8"));
const scenario = JSON.parse(readFileSync(SCENARIO, "utf8"));
const systemPrompt = buildSystemPrompt({ persona, character: { manifest } });

const config = {
  systemPrompt,
  mode: persona.mode,
  language: persona.language,
  voice: VOICE,
  privacyMode: "default",
  characterId: manifest.id,
  personaId: persona.id,
  providerOptions: { speakingStyle: persona.speakingStyle, turnPolicy: persona.turnPolicy, opening: persona.opening },
};

const sock = new WebSocket(AGENT);
const turns = []; // { user, reply, firstAudioMs, doneMs, interrupted }
let current = null;
let resolveDone = null;
let ready = false;
let outRate = 24000;
let audioSamples = 0;

sock.on("message", (data, isBinary) => {
  if (isBinary) {
    const rate = data.readUInt32LE(0);
    outRate = rate;
    audioSamples += (data.length - 12) / 2;
    if (current && current.firstAudioMs === undefined) current.firstAudioMs = Date.now() - current.sentAt;
    return;
  }
  const m = JSON.parse(data.toString());
  if (m.type === "ready") ready = true;
  if (m.type === "assistant_transcript" && m.final) {
    if (current) current.reply = m.text;
    else turns.push({ user: null, reply: m.text, opening: true });
  }
  if (m.type === "assistant_speech_ended" || (m.type === "assistant_transcript" && m.final && !current)) {
    if (current) {
      current.doneMs = Date.now() - current.sentAt;
      current.speechSec = audioSamples / outRate;
    }
    resolveDone?.();
  }
  if (m.type === "error") console.error("  [agent error]", m.message);
});

const waitFor = (pred, ms) => new Promise((res) => { const t0 = Date.now(); const i = setInterval(() => { if (pred() || Date.now() - t0 > ms) { clearInterval(i); res(); } }, 20); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((res, rej) => { sock.once("open", res); sock.once("error", rej); });
sock.send(JSON.stringify({ type: "start", config }));
await waitFor(() => ready, 10_000);
if (!ready) throw new Error("agent never sent ready");
// Let the opening line play out first.
await new Promise((res) => { resolveDone = res; setTimeout(res, 12_000); });
await sleep(LISTEN_PAUSE_MS);

console.log(`\n=== 会話品質 ${persona.id} / ${manifest.name} / ${scenario.title} ===`);
for (const line of scenario.turns) {
  const t = { user: line.text, sentAt: Date.now(), checks: line.expect ?? null };
  current = t;
  audioSamples = 0;
  turns.push(t);
  console.log(`  You: ${line.text}`);
  const done = new Promise((res) => { resolveDone = res; });
  sock.send(JSON.stringify({ type: "text", text: line.text }));
  await Promise.race([done, sleep(REPLY_TIMEOUT_MS)]);
  if (t.doneMs === undefined) t.timedOut = true;
  console.log(`  Yui: ${t.reply ?? "(no reply)"}   [${t.firstAudioMs ?? "-"}ms → ${t.doneMs ?? "timeout"}ms, ${t.speechSec?.toFixed(1) ?? "?"}s]`);
  current = null;
  await sleep(LISTEN_PAUSE_MS);
}
sock.send(JSON.stringify({ type: "stop" }));

// ---- scoring --------------------------------------------------------------------------------------
const replies = turns.filter((t) => t.user && t.reply);
const chars = replies.map((t) => t.reply.length);
const sentences = replies.map((t) => (t.reply.match(/[。！？!?]/g) ?? []).length || 1);
const pct = (v, p) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]; };
const questions = replies.filter((t) => /[？?]/.test(t.reply)).length;
const backchannelOnly = replies.filter((t) => t.reply.length < 12).length;
const greetings = replies.filter((t, i) => i > 0 && /^(こんにちは|こんばんは|おつかれ|はじめまして|やあ)/.test(t.reply)).length;
let sameOpening = 0;
for (let i = 1; i < replies.length; i++) if (replies[i].reply.slice(0, 3) === replies[i - 1].reply.slice(0, 3)) sameOpening++;
const checks = [];
for (const t of replies) {
  if (!t.checks) continue;
  for (const [name, spec] of Object.entries(t.checks)) {
    let ok;
    if (spec.any) ok = spec.any.some((k) => t.reply.includes(k));
    else if (spec.minChars) ok = t.reply.length >= spec.minChars;
    else if (spec.noQuestion) ok = !/[？?]/.test(t.reply);
    else ok = false;
    checks.push({ turn: t.user, name, ok, reply: t.reply });
  }
}
const firstAudio = replies.map((t) => t.firstAudioMs).filter((x) => x !== undefined);
const summary = {
  persona: persona.id, character: manifest.id, scenario: scenario.title, at: new Date().toISOString(),
  turns: replies.length, timeouts: turns.filter((t) => t.timedOut).length,
  replyChars: { p50: pct(chars, 50), avg: Math.round(chars.reduce((a, b) => a + b, 0) / (chars.length || 1)), max: Math.max(0, ...chars) },
  sentences: { p50: pct(sentences, 50), max: Math.max(0, ...sentences) },
  questionRate: replies.length ? Math.round((100 * questions) / replies.length) : 0,
  backchannelOnly, greetingsMidConversation: greetings, sameOpeningAsPrevious: sameOpening,
  checksPassed: checks.filter((c) => c.ok).length, checksTotal: checks.length,
  firstAudioMs: { p50: pct(firstAudio, 50), p95: pct(firstAudio, 95) },
  speechSecTotal: Number(replies.reduce((a, t) => a + (t.speechSec ?? 0), 0).toFixed(1)),
};
console.log("\n| 指標 | 値 |\n|---|---|");
console.log(`| 返答文字数 p50 / avg / max | ${summary.replyChars.p50} / ${summary.replyChars.avg} / ${summary.replyChars.max} |`);
console.log(`| 文数 p50 / max | ${summary.sentences.p50} / ${summary.sentences.max} |`);
console.log(`| 質問を返した | ${questions}/${replies.length} (${summary.questionRate}%) |`);
console.log(`| 相槌だけ(<12字) | ${backchannelOnly} |`);
console.log(`| 途中で挨拶 | ${greetings} |`);
console.log(`| 直前と同じ書き出し | ${sameOpening} |`);
console.log(`| 記憶・内容チェック | ${summary.checksPassed}/${summary.checksTotal} |`);
console.log(`| 初音 p50 / p95 | ${summary.firstAudioMs.p50} / ${summary.firstAudioMs.p95} ms |`);
console.log(`| タイムアウト | ${summary.timeouts} |`);
for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}  ← 「${c.reply}」`);

mkdirSync(OUT, { recursive: true });
const stamp = summary.at.replace(/[:.]/g, "-").slice(0, 19);
const path = join(OUT, `${persona.id}-${stamp}.json`);
writeFileSync(path, JSON.stringify({ summary, systemPrompt, turns, checks }, null, 2));
console.log(`\n→ ${path}`);
sock.close();
process.exit(0);
