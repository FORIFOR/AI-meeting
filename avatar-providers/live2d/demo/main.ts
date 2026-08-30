import { AvatarRuntime, loadCharacter, type Emotion, type Gesture } from "@rcai/avatar-core";
import { SpeakerOutput, createFrame } from "@rcai/audio-core";
import { BehaviorEngine } from "@rcai/behavior-engine";
import type { ConversationEvent } from "@rcai/conversation-core";
import { Live2DAvatarProvider } from "../src/index.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = (msg: string) => {
  const el = $("log");
  el.textContent = `${new Date().toISOString().slice(11, 23)} ${msg}\n${el.textContent}`.slice(0, 4000);
  console.log("[demo]", msg);
};

const characterId = new URLSearchParams(location.search).get("character") ?? "yui";
$("char").textContent = characterId;

const stage = $("stage");
const provider = new Live2DAvatarProvider({ container: stage, onDiagnostic: (d) => log(`diag ${JSON.stringify(d)}`) });
const runtime = new AvatarRuntime(provider);
let engine: BehaviorEngine | null = null;
const speaker = new SpeakerOutput();
speaker.tap.subscribe((f) => provider.pushAudio(f));

const mouthLog: { t: number; open: number }[] = [];
(window as unknown as { __rcai: unknown }).__rcai = { provider, runtime, speaker, mouthLog, get engine() { return engine; } };

async function main() {
  const def = await loadCharacter(`/characters/${characterId}`);
  stage.style.background = def.view?.background ?? "#f6f1ea";
  await provider.prepare(def);
  await provider.start();
  engine = new BehaviorEngine(runtime, { mode: "free_talk" });
  engine.start();
  log(`ready: ${def.manifest.name} (${def.model})`);

  document.querySelectorAll<HTMLButtonElement>("button[data-ev]").forEach((b) => {
    b.addEventListener("click", () => {
      const ev = { type: b.dataset.ev } as ConversationEvent;
      if (ev.type === "interrupted") {
        const t0 = performance.now();
        speaker.interrupt();
        runtime.handleEvent(ev);
        const p = provider.getParams();
        log(`INTERRUPT: mouthOpenY=${p.mouthOpenY.toFixed(3)} after ${(performance.now() - t0).toFixed(2)} ms (same tick)`);
      } else runtime.handleEvent(ev);
      engine?.handleEvent(ev);
      log(`event ${ev.type} → ${runtime.state}`);
    });
  });
  const emotions: Emotion[] = ["neutral", "smile", "laugh", "serious", "sad", "thinking", "surprised", "warm_positive", "concerned", "encourage"];
  for (const e of emotions) {
    const b = document.createElement("button");
    b.textContent = e;
    b.onclick = () => { provider.setEmotion(e, 0.8); log(`emotion ${e}`); };
    $("emotions").appendChild(b);
  }
  const gestures: Gesture[] = ["nod_small", "nod_normal", "nod_strong", "head_tilt", "surprised", "happy", "laugh_soft", "concerned", "greeting", "bow", "celebrate", "eyebrow_raise"];
  for (const g of gestures) {
    const b = document.createElement("button");
    b.textContent = g;
    b.onclick = () => { provider.performGesture(g, 0.7); log(`gesture ${g}`); };
    $("gestures").appendChild(b);
  }
  $("btn-blink").onclick = () => provider.blink(160);
  $("btn-behavior").onclick = () => { if (engine) { engine.stop(); engine = null; log("behavior engine OFF"); } else { engine = new BehaviorEngine(runtime, { mode: "free_talk" }); engine.start(); log("behavior engine ON"); } };
  $("btn-audio").onclick = () => void playTestAudio();

  setInterval(() => {
    const p = provider.getParams();
    const ls = provider.lipSync.sample();
    mouthLog.push({ t: performance.now(), open: p.mouthOpenY });
    if (mouthLog.length > 600) mouthLog.shift();
    $("overlay").textContent = [
      `state=${runtime.state}  speaking=${provider.stack.isSpeaking}  lipsync=${provider.diagnostics.lipSync}  blocked=${provider.diagnostics.blocked.join(",") || "-"}`,
      `mouthOpenY=${p.mouthOpenY.toFixed(3)} mouthForm=${p.mouthForm.toFixed(2)} level=${ls.levelDb.toFixed(1)}dB visemes a=${ls.visemes.a.toFixed(2)} i=${ls.visemes.i.toFixed(2)} u=${ls.visemes.u.toFixed(2)}`,
      `angleX=${p.angleX.toFixed(2)} angleY=${p.angleY.toFixed(2)} angleZ=${p.angleZ.toFixed(2)} bodyX=${p.bodyAngleX.toFixed(2)}`,
      `eyeLOpen=${p.eyeLOpen.toFixed(2)} eyeBallX=${p.eyeBallX.toFixed(2)} eyeBallY=${p.eyeBallY.toFixed(2)} browLY=${p.browLY.toFixed(2)} smile=${p.eyeLSmile.toFixed(2)} cheek=${p.cheek.toFixed(2)}`,
      `clips idle=${provider.stack.currentClip("idle")?.id ?? "-"} speech=${provider.stack.currentClip("speech")?.id ?? "-"} gesture=${provider.stack.currentClip("gesture")?.id ?? "-"}`,
    ].join("\n");
  }, 100);
}

/** Synthesises a Japanese-like vowel sequence (a i u e o, with pauses) and plays it through the speaker tap. */
function synthVowels(sampleRate = 48000): Float32Array {
  const seq: [number, number, number][] = [[800, 1200, 260], [300, 2400, 220], [320, 750, 220], [500, 1900, 220], [450, 900, 260], [0, 0, 220], [800, 1200, 180], [300, 2400, 180], [0, 0, 150], [450, 900, 240], [800, 1200, 300]];
  const parts: Float32Array[] = [];
  for (const [f1, f2, ms] of seq) {
    const n = Math.round((sampleRate * ms) / 1000);
    const out = new Float32Array(n);
    if (f1 > 0) {
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        const env = Math.min(1, i / 400, (n - i) / 400);
        const glottal = 0.55 + 0.45 * Math.sin(2 * Math.PI * 130 * t);
        out[i] = env * (0.3 * Math.sin(2 * Math.PI * f1 * t) * glottal + 0.2 * Math.sin(2 * Math.PI * f2 * t) * glottal + 0.05 * Math.sin(2 * Math.PI * 2800 * t));
      }
    }
    parts.push(out);
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const all = new Float32Array(total);
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; }
  return all;
}

async function playTestAudio() {
  await speaker.resume();
  await speaker.whenReady();
  const pcm = synthVowels(speaker.context.sampleRate);
  const ev: ConversationEvent = { type: "assistant_speech_started" };
  runtime.handleEvent(ev);
  engine?.handleEvent(ev);
  log(`test audio: ${(pcm.length / speaker.context.sampleRate).toFixed(2)} s`);
  const chunk = Math.round(speaker.context.sampleRate * 0.02);
  for (let off = 0; off < pcm.length; off += chunk) speaker.play(createFrame(pcm.subarray(off, off + chunk), speaker.context.sampleRate));
  const durationMs = (pcm.length / speaker.context.sampleRate) * 1000 + 60;
  window.setTimeout(() => {
    if (runtime.state === "SPEAKING") {
      const end: ConversationEvent = { type: "assistant_speech_ended" };
      runtime.handleEvent(end);
      engine?.handleEvent(end);
      log(`test audio ended → ${runtime.state}, mouthOpenY=${provider.getParams().mouthOpenY.toFixed(3)}`);
    }
  }, durationMs);
}

main().catch((e) => {
  log(`ERROR ${e?.stack ?? e}`);
  $("overlay").textContent = `ERROR: ${e?.message ?? e}`;
});
