/**
 * LipSync A/B page: same character + MotionStack, engine chosen by ?engine=analyzer|motionsync.
 * `window.__ab.run(wavUrl)` plays a corpus WAV through SpeakerOutput (the real speaker tap feeds the
 * engine) and returns 60 Hz samples of the mouth parameters plus the played-audio envelope.
 */
import { AvatarRuntime, loadCharacter } from "@rcai/avatar-core";
import { SpeakerOutput, createFrame, type PCMFrame } from "@rcai/audio-core";
import { Live2DAvatarProvider, MotionSyncUnavailableError } from "../src/index.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = (msg: string) => { const el = $("log"); el.textContent = `${new Date().toISOString().slice(11, 23)} ${msg}\n${el.textContent}`.slice(0, 6000); };
const q = new URLSearchParams(location.search);
const engine = (q.get("engine") ?? "analyzer") as "analyzer" | "motionsync";
const characterId = q.get("character") ?? "yui";
$("engine").textContent = engine;
$("char").textContent = characterId;

export interface AbSample { t: number; open: number; form: number; a: number; i: number; u: number; e: number; o: number; levelDb: number }
export interface AbEnvelope { t: number; rms: number }
export interface AbRunResult { url: string; durationMs: number; startedAt: number; endedAt: number; samples: AbSample[]; envelope: AbEnvelope[]; interruptAt?: number; interruptOpenBefore?: number; interruptOpenAfter?: number; interruptMs?: number }

const state = { ready: false, error: null as string | null, diag: null as unknown, provider: null as Live2DAvatarProvider | null, runtime: null as AvatarRuntime | null, speaker: null as SpeakerOutput | null };
(window as unknown as { __ab: unknown }).__ab = {
  get ready() { return state.ready; },
  get error() { return state.error; },
  get diag() { return state.diag; },
  run: runWav,
  get provider() { return state.provider; },
};

async function main() {
  const stage = $("stage");
  const provider = new Live2DAvatarProvider({ container: stage, lipSyncEngine: engine, onDiagnostic: (d) => { state.diag = d; log(`diag ${JSON.stringify(d)}`); } });
  const runtime = new AvatarRuntime(provider);
  const speaker = new SpeakerOutput();
  state.provider = provider; state.runtime = runtime; state.speaker = speaker;
  speaker.tap.subscribe((f) => provider.pushAudio(f));
  try {
    const def = await loadCharacter(`/characters/${characterId}`);
    stage.style.background = def.view?.background ?? "#f6f1ea";
    await provider.prepare(def);
    await provider.start();
    state.ready = true;
    log(`ready engine=${provider.diagnostics.lipSync} blocked=${provider.diagnostics.blocked.join(",") || "-"}`);
  } catch (e) {
    const err = e as Error & { code?: string };
    state.error = err.code === "BLOCKED_BY_MOTIONSYNC_CORE" || e instanceof MotionSyncUnavailableError ? `BLOCKED_BY_MOTIONSYNC_CORE: ${err.message}` : `ERROR: ${err.message}`;
    log(state.error);
    $("overlay").textContent = state.error;
  }
  $("btn-run").onclick = () => void runWav(($("wav") as HTMLInputElement).value).then((r) => log(`run done: ${r.samples.length} samples, max open ${Math.max(...r.samples.map((s) => s.open)).toFixed(2)}`));
  setInterval(() => {
    const p = provider.getParams();
    const ls = provider.lipSync.sample();
    $("overlay").textContent = `state=${runtime.state} speaking=${provider.stack.isSpeaking} engine=${provider.diagnostics.lipSync}\nmouthOpenY=${p.mouthOpenY.toFixed(3)} mouthForm=${p.mouthForm.toFixed(2)} level=${ls.levelDb.toFixed(1)} a=${ls.visemes.a.toFixed(2)} i=${ls.visemes.i.toFixed(2)} u=${ls.visemes.u.toFixed(2)}`;
  }, 100);
}

async function decodeWav(url: string, ctx: AudioContext): Promise<Float32Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const buf = await ctx.decodeAudioData(await res.arrayBuffer());
  return buf.getChannelData(0).slice();
}

async function runWav(url: string, opts: { interruptAtMs?: number } = {}): Promise<AbRunResult> {
  const { provider, runtime, speaker } = state;
  if (!provider || !runtime || !speaker) throw new Error("not ready");
  await speaker.resume();
  await speaker.whenReady();
  const rate = speaker.context.sampleRate;
  const pcm = await decodeWav(url, speaker.context);
  const durationMs = (pcm.length / rate) * 1000;
  const samples: AbSample[] = [];
  const envelope: AbEnvelope[] = [];
  const unsub = speaker.tap.subscribe((f: PCMFrame) => {
    let s = 0;
    for (let i = 0; i < f.data.length; i++) s += (f.data[i] ?? 0) ** 2;
    envelope.push({ t: f.timestamp, rms: Math.sqrt(s / Math.max(1, f.data.length)) });
  });
  runtime.handleEvent({ type: "assistant_speech_started" });
  const startedAt = performance.now();
  const chunk = Math.round(rate * 0.02);
  for (let off = 0; off < pcm.length; off += chunk) speaker.play(createFrame(pcm.subarray(off, off + chunk), rate));
  const result: AbRunResult = { url, durationMs, startedAt, endedAt: 0, samples, envelope };
  let interrupted = false;
  await new Promise<void>((resolve) => {
    const tick = () => {
      const now = performance.now();
      const p = provider.getParams();
      const ls = provider.lipSync.sample();
      samples.push({ t: now, open: p.mouthOpenY, form: p.mouthForm, a: ls.visemes.a, i: ls.visemes.i, u: ls.visemes.u, e: ls.visemes.e, o: ls.visemes.o, levelDb: ls.levelDb });
      if (opts.interruptAtMs !== undefined && !interrupted && now - startedAt >= opts.interruptAtMs) {
        interrupted = true;
        const before = provider.getParams().mouthOpenY;
        const t0 = performance.now();
        speaker.interrupt();
        runtime.handleEvent({ type: "interrupted" });
        result.interruptAt = t0;
        result.interruptOpenBefore = before;
        result.interruptOpenAfter = provider.getParams().mouthOpenY;
        result.interruptMs = performance.now() - t0;
      }
      if (now - startedAt >= durationMs + 600) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  if (!interrupted) runtime.handleEvent({ type: "assistant_speech_ended" });
  result.endedAt = performance.now();
  unsub();
  return result;
}

main().catch((e) => { state.error = `ERROR: ${e?.message ?? e}`; log(state.error); });
