/**
 * Live meeting reality gate — a real Google Meet, with nobody having to talk.
 *
 * Sends the character in through Recall, and puts a second browser in the same call as an ordinary
 * guest whose microphone is synthesised Japanese speech (macOS `say`). Recall then hears real meeting
 * audio and produces real transcripts, which is the one part of the path that cannot be exercised from
 * outside a call: the in-bot transcript socket only exists inside a bot.
 *
 *   MEET_URL=https://meet.google.com/xxx-xxxx-xxx pnpm reality:meet:live
 *
 * You still have to admit two participants — Google Meet asks the host, and that is the point of a
 * waiting room. Everything after that is automatic.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.env.MEET_URL;
const minutes = Number(process.env.MINUTES ?? 3);
const guestName = process.env.GUEST_NAME ?? "Tester";
const LINES = (process.env.LINES ?? [
  "ゆいさん、聞こえていますか。",
  "ゆいさん、今日の会議の進め方について、どう思いますか。",
  "ゆいさん、来週までにやるべきことを教えてください。",
].join("|")).split("|");

if (!url || !/^https:\/\/meet\.google\.com\//.test(url)) {
  console.log("BLOCKED_BY_MEET_URL: set MEET_URL to a live Google Meet link");
  process.exit(2);
}

/** One WAV of the whole script with pauses, looped by Chrome as the guest's microphone. */
function buildWav() {
  const dir = mkdtempSync(join(tmpdir(), "rcai-meet-live-"));
  const parts = LINES.map((text, i) => {
    const aiff = join(dir, `l${i}.aiff`), wav = join(dir, `l${i}.wav`);
    execFileSync("say", ["-v", "Kyoko", "-o", aiff, text]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@48000", "-c", "1", aiff, wav]);
    return readFileSync(wav);
  });
  const dataOf = (b) => {
    let off = 12;
    while (off + 8 <= b.length) {
      const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
      if (id === "data") return b.subarray(off + 8, off + 8 + size);
      off += 8 + size + (size % 2);
    }
    return Buffer.alloc(0);
  };
  const gap = Buffer.alloc(48000 * 2 * 12); // 12 s between utterances: time to hear the answer
  const body = Buffer.concat(parts.flatMap((p) => [gap, dataOf(p)]));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + body.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(body.length, 40);
  const out = join(dir, "guest.wav");
  writeFileSync(out, Buffer.concat([header, body]));
  return out;
}

const wav = buildWav();
console.log(`guest microphone: ${LINES.length} utterances → ${wav}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false, // Meet is far friendlier to a real window, and you can watch what happens
  args: [
    "--no-sandbox", "--window-size=1100,820",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });

/** Meet's join screen: type a name if asked, then ask to join. Labels differ by locale. */
const clickByText = async (texts) => {
  return page.evaluate((wanted) => {
    const nodes = [...document.querySelectorAll("button, [role=button], span")];
    const hit = nodes.find((n) => wanted.some((w) => (n.textContent ?? "").trim().includes(w)));
    if (!hit) return false;
    (hit.closest("button") ?? hit).click();
    return true;
  }, texts);
};

await new Promise((r) => setTimeout(r, 6000));
try {
  const nameBox = await page.$('input[type="text"]');
  if (nameBox) { await nameBox.click({ clickCount: 3 }); await nameBox.type(guestName); }
} catch { /* signed in already */ }
for (const attempt of [0, 1, 2]) {
  if (await clickByText(["参加をリクエスト", "Ask to join", "今すぐ参加", "Join now"])) { console.log("guest: asked to join"); break; }
  if (attempt === 2) console.log("guest: could not find the join button — join it by hand in the window that opened");
  await new Promise((r) => setTimeout(r, 4000));
}

console.log(`\n>>> Admit BOTH participants in Meet: the character and "${guestName}".\n`);

// The observing side: the existing relay harness scores join → audio → transcript → addressed → answer.
const harness = spawn("pnpm", ["--filter", "@rcai/connector-recall", "e2e:meet"], {
  cwd: new URL("../..", import.meta.url).pathname,
  env: { ...process.env, MEET_URL: url, MODE: "relay", BROKER_URL: process.env.BROKER_URL ?? "http://localhost:8787", DURATION_MS: String(minutes * 60_000) },
  stdio: "inherit",
});
const code = await new Promise((r) => harness.on("exit", (c) => r(c ?? 1)));
await browser.close();
process.exit(code);
