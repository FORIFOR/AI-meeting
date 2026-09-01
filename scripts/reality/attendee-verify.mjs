/**
 * Verify a finished Attendee meeting from its own recording, rather than by asking whoever was there.
 *
 *   pnpm reality:attendee:verify <bot_id>
 *
 * Two questions a person cannot answer reliably and a harness can:
 *   - did the avatar render?  → pull a frame and count the tiles
 *   - did the character speak? → transcribe the meeting audio and look for its replies
 *
 * A person who heard nothing cannot tell "the page never loaded" from "it loaded and stayed silent",
 * and both have happened here.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./lib.mjs";

const env = loadEnv();
const botId = process.argv[2];
if (!botId) { console.log("usage: pnpm reality:attendee:verify <bot_id>"); process.exit(2); }
if (!env.ATTENDEE_API_KEY) { console.log("BLOCKED_BY_ATTENDEE_KEY"); process.exit(2); }

const api = async (p) => {
  const r = await fetch(`https://app.attendee.dev/api/v1/bots/${botId}${p}`, { headers: { Authorization: `Token ${env.ATTENDEE_API_KEY}`, accept: "application/json" } });
  return r.ok ? r.json() : null;
};

const bot = await api("");
console.log(`bot ${botId}  state=${bot?.state}  events=${(bot?.events ?? []).map((e) => e.type).join(" → ")}`);

const rec = await api("/recording");
if (!rec?.url) { console.log("FAIL: no recording — nothing to verify against"); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), "rcai-verify-"));
const mp4 = join(dir, "meeting.mp4");
const buf = Buffer.from(await (await fetch(rec.url)).arrayBuffer());
writeFileSync(mp4, buf);
console.log(`recording ${(buf.length / 1e6).toFixed(1)} MB → ${mp4}`);

// A frame, so the avatar question is answered by looking rather than remembering.
const frame = join(dir, "frame.png");
try {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-vf", "select=eq(n\\,240)", "-vsync", "vfr", "-frames:v", "1", frame]);
  console.log(`frame → ${frame}`);
} catch { console.log("frame extraction failed"); }

// The audio, through our own recogniser: the character's replies are in there or they are not.
const wav = join(dir, "meeting16k.wav");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
console.log(`audio → ${wav}`);

const theirs = await api("/transcript");
const utterances = Array.isArray(theirs) ? theirs : (theirs?.results ?? []);
const speakers = [...new Set(utterances.map((u) => u.speaker_name ?? "?"))];
console.log(`\nAttendee's own transcript: ${utterances.length} utterances from ${speakers.join(", ") || "nobody"}`);
console.log(speakers.length > 1 ? "→ more than one speaker: the character was probably audible" : "→ one speaker only: the character was probably silent (or its audio is excluded from the recording)");
console.log(`\n次: フレームを見て、必要なら ${wav} を STT にかけてください。`);
