/**
 * Round 3 Gate 4 evaluation: streams each corpus WAV in real time into a running agent and measures
 *   endpoint delay (user_speech_ended − ground-truth end), premature endpoints (ended before the user
 *   finished), false continuations (> 1.5 s late) and the KPI true-end → first assistant audio.
 * One WS session per item (isolated policy state). Usage:
 *   AGENT_URL=http://127.0.0.1:8792 pnpm --filter @rcai/agent exec tsx scripts/endpointing-eval.ts [label]
 */
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
import { parseWav } from "../src/wav.js";

const AGENT = process.env.AGENT_URL ?? "http://127.0.0.1:8792";
const WS_URL = AGENT.replace(/^http/, "ws") + "/session";
const LABEL = process.argv[2] ?? "run";
const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "../../../tools/endpointing-corpus/wav/manifest.json"), "utf8")) as { id: string; tag: string; text: string; file: string; pauseMs: number; groundTruthEndMs: number }[];
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

interface Row { id: string; tag: string; text: string; gtEndMs: number; endpointMs: number | null; endpointDelayMs: number | null; premature: boolean; falseContinuation: boolean; firstAudioMs: number | null; kpiMs: number | null; transcript: string; reason?: string; sttReused?: boolean; sttMs?: number; llmTtftMs?: number; firstPhraseMs?: number; ttsTtfaMs?: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function pct(v: number[], p: number): number { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!; }

async function runItem(item: (typeof manifest)[number]): Promise<Row> {
  const wav = parseWav(new Uint8Array(fs.readFileSync(item.file)));
  const pcm = wav.pcm16;
  const ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";
  const row: Row = { id: item.id, tag: item.tag, text: item.text, gtEndMs: item.groundTruthEndMs, endpointMs: null, endpointDelayMs: null, premature: false, falseContinuation: false, firstAudioMs: null, kpiMs: null, transcript: "" };
  let t0 = 0;
  let ready = false;
  let done = false;
  const endedTimes: number[] = [];
  ws.on("message", (data, isBinary) => {
    const t = Date.now() - t0;
    if (isBinary) {
      if (row.firstAudioMs === null) row.firstAudioMs = t;
      return;
    }
    const j = JSON.parse(data.toString());
    if (j.type === "ready") ready = true;
    if (j.type === "user_speech_ended") endedTimes.push(t);
    if (j.type === "user_transcript") row.transcript = j.text;
    if (j.type === "metrics") { row.reason = j.turn.endpointReason; row.sttReused = j.turn.sttReused; row.sttMs = j.turn.sttMs; row.llmTtftMs = j.turn.llmTtftMs; row.firstPhraseMs = j.turn.firstPhraseMs; row.ttsTtfaMs = j.turn.ttsTtfaMs; }
    if (j.type === "assistant_speech_started") done = true;
    if (j.type === "error") console.log("  error:", j.message);
  });
  await new Promise<void>((r) => ws.on("open", () => r()));
  ws.send(JSON.stringify({ type: "start", config: { systemPrompt: "あなたはYuiです。話し言葉で1文だけ短く返答してください。", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local" } }));
  while (!ready) await sleep(5);
  // 300 ms leading silence, then the utterance at real time, then silence until the assistant starts (max 4 s).
  t0 = Date.now();
  const chunk = 320;
  const silent = new Int16Array(chunk);
  const sendAt = async (idx: number, buf: Int16Array) => {
    const target = t0 + idx * 20;
    const d = target - Date.now();
    if (d > 0) await sleep(d);
    ws.send(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
  };
  let idx = 0;
  for (let i = 0; i < 15; i++) await sendAt(idx++, silent);
  const offsetMs = 300;
  for (let off = 0; off < pcm.length; off += chunk) {
    const part = pcm.subarray(off, Math.min(pcm.length, off + chunk));
    const padded = part.length === chunk ? part : (() => { const p = new Int16Array(chunk); p.set(part); return p; })();
    await sendAt(idx++, padded);
  }
  const deadline = Date.now() + 4500;
  while (!done && Date.now() < deadline) await sendAt(idx++, silent);
  // metrics arrive after the first audio; keep streaming silence briefly so the message is captured
  const grace = Date.now() + 400;
  while (row.reason === undefined && Date.now() < grace) await sendAt(idx++, silent);
  ws.send(JSON.stringify({ type: "interrupt" }));
  ws.send(JSON.stringify({ type: "stop" }));
  ws.close();
  const gt = offsetMs + item.groundTruthEndMs;
  const firstEnd = endedTimes[0] ?? null;
  row.endpointMs = firstEnd;
  row.endpointDelayMs = firstEnd !== null ? firstEnd - gt : null;
  row.premature = firstEnd !== null && firstEnd < gt - 30; // ended before the user finished (tolerance for the say tail)
  row.falseContinuation = firstEnd !== null && firstEnd - gt > 1500;
  row.kpiMs = row.firstAudioMs !== null ? row.firstAudioMs - gt : null;
  return row;
}

async function main() {
  const health = await (await fetch(`${AGENT}/health`)).json();
  console.log("health:", JSON.stringify(health.stt), "tts:", health.tts?.engine);
  const rows: Row[] = [];
  for (const item of manifest) {
    if (ONLY && !ONLY.has(item.id)) continue;
    const r = await runItem(item);
    rows.push(r);
    console.log(`${r.id.padEnd(4)} ${r.tag.padEnd(20)} ep=${r.endpointDelayMs === null ? "—" : `${r.endpointDelayMs}ms`}${r.premature ? " PREMATURE" : ""}${r.falseContinuation ? " LATE" : ""} kpi=${r.kpiMs ?? "—"} reused=${r.sttReused ? 1 : 0} "${r.transcript.slice(0, 24)}" (${r.reason ?? ""})`);
    await sleep(300);
  }
  const ok = rows.filter((r) => r.endpointDelayMs !== null);
  const summary = {
    label: LABEL,
    stt: health.stt,
    n: rows.length,
    endpointDelayP50: pct(ok.map((r) => r.endpointDelayMs!), 50),
    endpointDelayP95: pct(ok.map((r) => r.endpointDelayMs!), 95),
    prematureRate: rows.filter((r) => r.premature).length / rows.length,
    prematureIds: rows.filter((r) => r.premature).map((r) => r.id),
    falseContinuationRate: rows.filter((r) => r.falseContinuation).length / rows.length,
    missedEndpoints: rows.filter((r) => r.endpointDelayMs === null).map((r) => r.id),
    kpiP50: pct(rows.filter((r) => r.kpiMs !== null).map((r) => r.kpiMs!), 50),
    kpiP95: pct(rows.filter((r) => r.kpiMs !== null).map((r) => r.kpiMs!), 95),
    sttReusedRate: rows.filter((r) => r.sttReused).length / rows.length,
    byTag: Object.fromEntries([...new Set(rows.map((r) => r.tag))].map((tag) => { const rs = rows.filter((r) => r.tag === tag); return [tag, { n: rs.length, epP50: pct(rs.filter((r) => r.endpointDelayMs !== null).map((r) => r.endpointDelayMs!), 50), premature: rs.filter((r) => r.premature).length, kpiP50: pct(rs.filter((r) => r.kpiMs !== null).map((r) => r.kpiMs!), 50) }]; })),
    rows,
  };
  const outDir = path.join(here, "../../../docs/reports/endpointing");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${LABEL}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
  console.log("saved", file);
}
main().catch((e) => { console.error(e); process.exit(1); });
