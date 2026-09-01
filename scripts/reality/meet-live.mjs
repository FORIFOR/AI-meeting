/**
 * Live meeting reality gate — a real Google Meet with nobody having to talk.
 *
 * The hop that cannot be exercised from outside a call is the meeting one: the character answers when it
 * hears its name, and the name arrives on Recall's in-bot transcript socket, which exists only inside a
 * bot. So put a second speaker in the call — also a Recall bot, because Google Meet will not let an
 * anonymous browser near this meeting at all ("あなたはこのビデオハングアウトに参加できません"), and
 * signing one in is not something a test harness should be doing with someone's account.
 *
 *   MEET_URL=https://meet.google.com/xxx-xxxx-xxx pnpm reality:meet:live
 *
 * A host still admits two participants — the character, and the speaker. That is Meet doing its job.
 *
 * TRANSPORT TEST ONLY. It proves audio and transcripts move through Meet; it does not stand in for
 * `pnpm reality:meet:human`, which is the gate. The speaker bot uses Output Audio — short pre-recorded
 * clips, which is what Recall says that endpoint is for — so it needs RECALL_ALLOW_OUTPUT_AUDIO=1 on the
 * broker. The character's own conversational audio never goes through it.
 */
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./lib.mjs";

const env = loadEnv();
const url = process.env.MEET_URL;
const broker = process.env.BROKER_URL ?? "http://localhost:8787";
const minutes = Number(process.env.MINUTES ?? 4);
const speakerName = process.env.SPEAKER_NAME ?? "Tester";
const LINES = (process.env.LINES ?? [
  "ゆいさん、聞こえていますか。",
  "ゆいさん、今日の会議の進め方について、どう思いますか。",
  "ゆいさん、来週までにやることを教えてください。",
].join("|")).split("|");
const GAP_MS = Number(process.env.GAP_MS ?? 14000);

if (!url || !/^https:\/\/meet\.google\.com\//.test(url)) {
  console.log("BLOCKED_BY_MEET_URL: set MEET_URL to a live Google Meet link");
  process.exit(2);
}
if (!env.RECALL_API_KEY) { console.log("BLOCKED_BY_RECALL_KEY"); process.exit(2); }

/** macOS `say` → mp3, which is what Recall's Output Audio accepts. */
function speechMp3(text, dir, i) {
  const aiff = join(dir, `s${i}.aiff`), mp3 = join(dir, `s${i}.mp3`);
  execFileSync("say", ["-v", "Kyoko", "-o", aiff, text]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-codec:a", "libmp3lame", "-b:a", "64k", "-ac", "1", "-ar", "44100", mp3]);
  return readFileSync(mp3).toString("base64");
}
const dir = mkdtempSync(join(tmpdir(), "rcai-meet-live-"));
const clips = LINES.map((t, i) => speechMp3(t, dir, i));
console.log(`speaker: ${LINES.length} utterances encoded`);

const post = async (path, body) => {
  const res = await fetch(`${broker}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

// The character under test, scored by the existing relay harness (join → audio → transcript → addressed → answer).
const harness = spawn("pnpm", ["--filter", "@rcai/connector-recall", "e2e:meet"], {
  cwd: new URL("../..", import.meta.url).pathname,
  env: { ...env, ...process.env, MEET_URL: url, MODE: "relay", BROKER_URL: broker, DURATION_MS: String(minutes * 60_000) },
  stdio: "inherit",
});

// The other participant: a plain recording bot we push audio into.
const created = await post("/api/meeting/recall/bots", { meetingUrl: url, botName: speakerName, language: "ja", mode: "relay", force: true });
if (created.status !== 200) {
  console.log(`FAIL: could not create the speaker bot — ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
  harness.kill(); process.exit(1);
}
const speakerId = created.json.botId;
console.log(`\n>>> Admit BOTH in Meet: the character, and "${speakerName}".\n`);

const inCall = async () => {
  const res = await fetch(`${broker}/api/meeting/recall/bots/${speakerId}`);
  const j = await res.json().catch(() => ({}));
  return String(j.code ?? j.status ?? "") === "in_call_recording";
};
for (let waited = 0; waited < 240_000; waited += 5000) {
  if (await inCall()) { console.log(`speaker: in the call after ${waited / 1000}s`); break; }
  await new Promise((r) => setTimeout(r, 5000));
}

for (const [i, b64] of clips.entries()) {
  const r = await post(`/api/meeting/recall/bots/${speakerId}/output_audio`, { kind: "mp3", b64_data: b64 });
  console.log(`speaker[${i + 1}/${clips.length}] ${r.status === 200 ? "said" : `FAILED ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`}: ${LINES[i]}`);
  await new Promise((r2) => setTimeout(r2, GAP_MS));
}

const code = await new Promise((r) => harness.on("exit", (c) => r(c ?? 1)));
await post(`/api/meeting/recall/bots/${speakerId}/leave`);
process.exit(code);
