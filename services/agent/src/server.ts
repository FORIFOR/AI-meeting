import { createServer } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import type { EvaluationInput } from "@rcai/provider-core";
import type { MotionPlanInput } from "@rcai/behavior-engine";
import { loadConfig, nonLoopbackEndpoints, type AgentConfig } from "./config.js";
import { clearEgressLog, getEgressLog, installEgressGuard, setStrictEgressBlock } from "./egress.js";
import { SherpaSTT, WhisperServerSTT, type STTAdapter } from "./adapters/stt.js";
import { IncrementalOfflineSTT, type StreamingSTT } from "./adapters/stt-streaming.js";
import { SherpaOnlineSTT } from "./adapters/sherpa-online.js";
import { EnergyVADAdapter, SileroVAD, type VADAdapter } from "./adapters/vad.js";
import { OpenAICompatibleLLM } from "./adapters/llm.js";
import { AivisSpeechTTS, AVSpeechDaemonTTS, SayTTS, StyleBertVits2TTS, SupertonicTTS, type TTSAdapter } from "./adapters/tts.js";
import { SmartTurnV3 } from "./adapters/turn.js";
import { ConversationSession } from "./session.js";
import { pcm16BytesToFloat32, type ClientMessage } from "./protocol.js";
import { planWithLocalLlm } from "./planner.js";
import { evaluateLocally } from "./evaluation-bridge.js";

export interface AgentRuntime {
  cfg: AgentConfig;
  stt: STTAdapter;
  llm: OpenAICompatibleLLM;
  tts: TTSAdapter;
  vadEngine: string;
  createVad(): VADAdapter;
  /** Round 3: effective STT mode after fallbacks ("baseline" keeps the Gate 6 path byte-for-byte). */
  sttMode: "baseline" | "incremental" | "online";
  createStreamingStt: (() => StreamingSTT) | null;
  /** Acoustic turn-end model; null when the model has not been fetched or LOCAL_TURN=off. */
  turn: SmartTurnV3 | null;
  /** Stronger recogniser used once per turn on the committed utterance (null when unavailable/disabled). */
  finalStt: STTAdapter | null;
}

export async function createRuntime(cfg: AgentConfig = loadConfig()): Promise<AgentRuntime> {
  let stt: STTAdapter;
  if (cfg.stt === "whisper") {
    const w = new WhisperServerSTT(cfg.whisperServerUrl);
    await w.init();
    stt = w;
  } else {
    const s = new SherpaSTT(cfg.sherpaModelDir);
    await s.init();
    stt = s;
    if (!s.ready) {
      const w = new WhisperServerSTT(cfg.whisperServerUrl);
      await w.init();
      if (w.ready) stt = w;
    }
  }
  /**
   * Second-pass recogniser for the committed utterance.
   *
   * The streaming pass has to answer while the user is still talking, so it decodes prefixes of the audio
   * and its final text is measurably worse than one decode of the whole utterance — on the same SenseVoice
   * model. Re-running the *same* model changes nothing — the incremental decoder already decodes the whole
   * utterance — so the second pass is only worth it with a stronger one: LOCAL_STT_FINAL=whisper recovers
   * 「ゆいさん」 where SenseVoice returns 「ういさん」, at ~1 s per turn (whisper.cpp always processes a 30 s
   * window, so the cost barely varies with utterance length). Off by default: that second is expensive in
   * a live conversation, and the cloud providers do not need it at all.
   */
  let finalStt: STTAdapter | null = null;
  if (cfg.sttFinal === "whisper") {
    const w = new WhisperServerSTT(cfg.whisperServerUrl);
    await w.init();
    if (w.ready) finalStt = w;
    else console.warn("[agent] LOCAL_STT_FINAL=whisper but whisper-server is not reachable at", cfg.whisperServerUrl);
  }
  const llm = new OpenAICompatibleLLM(cfg.llmUrl, cfg.llmModel, undefined, cfg.llmKey || undefined, cfg.llmReasoning || undefined);
  await llm.init();

  /**
   * Acoustic turn-end. Loaded once and shared: the model is 8 MB and stateless, and a per-session copy
   * would cost a second of load time at the worst possible moment.
   */
  let turn: SmartTurnV3 | null = null;
  if (cfg.turn !== "off" && cfg.smartTurnModel) {
    const t = new SmartTurnV3(cfg.smartTurnModel);
    await t.init();
    if (t.ready) turn = t;
    else console.warn("[agent] BLOCKED_BY_SMART_TURN:", t.initError ?? "model did not load", "— endpointing stays silence + text only");
  }

  const tts = await selectTts(cfg);
  const probe = new SileroVAD(cfg.sileroVadModel, { minSilenceSec: cfg.vadMinSilenceMs / 1000 });
  const vadEngine = probe.available ? "silero-vad" : "energy-vad";
  // Round 3: streaming STT mode. Energy VAD has no reliable short-pause detection → baseline only.
  let sttMode: AgentRuntime["sttMode"] = probe.available ? cfg.sttMode : "baseline";
  let online: SherpaOnlineSTT | null = null;
  if (sttMode === "online") {
    online = new SherpaOnlineSTT(cfg.sherpaOnlineModelDir);
    online.init();
    if (!online.ready) {
      console.warn("[agent] BLOCKED_BY_NO_JA_STREAMING_MODEL: no streaming recognizer at", cfg.sherpaOnlineModelDir ?? "(unset SHERPA_ONLINE_MODEL_DIR)", "— using incremental re-decode");
      sttMode = "incremental";
      online = null;
    }
  }
  if (sttMode !== "baseline" && !stt.ready) sttMode = "baseline";
  const pauseSec = cfg.pauseMinSilenceMs / 1000;

  const createStreamingStt: AgentRuntime["createStreamingStt"] =
    sttMode === "online" && online ? () => online!.clone() : sttMode === "incremental" ? () => new IncrementalOfflineSTT(stt, { intervalMs: cfg.sttIncrementalIntervalMs }) : null;
  return {
    cfg,
    stt,
    llm,
    tts,
    vadEngine,
    sttMode,
    createStreamingStt,
    finalStt,
    turn,
    createVad: () =>
      probe.available
        ? new SileroVAD(cfg.sileroVadModel, { minSilenceSec: sttMode === "baseline" ? cfg.vadMinSilenceMs / 1000 : pauseSec })
        : new EnergyVADAdapter(),
  };
}

/**
 * TTS selection: sbv2 (quality, needs a server) → avspeech daemon (resident, ~60 ms TTFA) → say (spawn, ~700 ms).
 * `auto` prefers the daemon when built; explicit engines fall back only when unavailable.
 */
export async function selectTts(cfg: AgentConfig): Promise<TTSAdapter> {
  /**
   * AivisSpeech first when it is there. The macOS voices read a sentence; a character has to sound
   * like someone, and that difference is most of what people react to. It is local either way, so
   * preferring it costs no privacy — only the engine being installed and running.
   */
  /**
   * Explicit only. Supertonic sounds like a person and runs on this machine, but it is ~0.6× realtime
   * against the resident daemon's 60 ms to first audio — a quality choice, not a default one.
   */
  if (cfg.tts === "supertonic" && cfg.supertonicDir) {
    const s3 = new SupertonicTTS(cfg.supertonicDir, cfg.supertonicVoice, { steps: cfg.supertonicSteps, speed: cfg.supertonicSpeed, precision: cfg.supertonicPrecision });
    await s3.init();
    if (s3.ready) return s3;
    console.warn("[agent] BLOCKED_BY_SUPERTONIC:", s3.initError ?? "weights not found — run scripts/fetch-supertonic.sh", "— falling back");
  }
  if (cfg.tts === "aivis" || cfg.tts === "auto") {
    const a = new AivisSpeechTTS(cfg.aivisUrl, cfg.aivisVoice);
    await a.init();
    if (a.ready) return a;
    if (cfg.tts === "aivis") console.warn("[agent] BLOCKED_BY_AIVIS_SERVER: no AivisSpeech Engine at", cfg.aivisUrl, "— falling back");
  }
  if (cfg.tts === "sbv2") {
    const s = new StyleBertVits2TTS(cfg.sbv2Url);
    await s.init();
    if (s.ready) return s;
    console.warn("[agent] BLOCKED_BY_SBV2_SERVER: Style-Bert-VITS2 not reachable at", cfg.sbv2Url, "— falling back to local macOS TTS");
  }
  if (cfg.tts === "avspeech" || cfg.tts === "auto" || cfg.tts === "sbv2") {
    if (cfg.ttsDaemonPath) {
      const d = new AVSpeechDaemonTTS({ binaryPath: cfg.ttsDaemonPath, voice: cfg.avspeechVoice });
      await d.init();
      if (d.ready) return d;
      console.warn("[agent] tts daemon at", cfg.ttsDaemonPath, "did not answer — falling back to say");
    } else if (cfg.tts === "avspeech") {
      console.warn("[agent] LOCAL_TTS=avspeech but tools/tts-daemon/bin/rcai-tts-daemon is not built (run tools/tts-daemon/build.sh) — falling back to say");
    }
  }
  const say = new SayTTS(cfg.sayVoice);
  await say.init();
  return say;
}

export function createApp(rt: AgentRuntime): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: (o) => o ?? "*" }));
  app.get("/health", (c) =>
    c.json({
      ok: true,
      strictLocalCapable: true,
      stt: { engine: rt.stt.engine, ready: rt.stt.ready, model: rt.stt.model, mode: rt.sttMode, finalPass: rt.finalStt ? rt.finalStt.model : null, pauseMinSilenceMs: rt.sttMode === "baseline" ? rt.cfg.vadMinSilenceMs : rt.cfg.pauseMinSilenceMs, endpoint: rt.sttMode === "baseline" ? null : rt.cfg.endpoint },
      llm: { engine: rt.llm.engine, ready: rt.llm.ready, model: rt.llm.model, url: rt.cfg.llmUrl },
      tts: { engine: rt.tts.engine, ready: rt.tts.ready, voice: rt.tts.voice, voices: rt.tts.voices ?? [], precision: (rt.tts as { precision?: string }).precision },
      turn: { engine: rt.turn?.engine ?? null, ready: !!rt.turn?.ready },
      vad: { engine: rt.vadEngine },
    }),
  );
  app.get("/egress", (c) => c.json({ entries: getEgressLog() }));
  app.delete("/egress", (c) => {
    clearEgressLog();
    return c.json({ ok: true });
  });
  app.post("/plan", async (c) => {
    const input = (await c.req.json()) as MotionPlanInput;
    return c.json(await planWithLocalLlm(input, rt.llm));
  });
  app.post("/evaluate", async (c) => {
    const input = (await c.req.json()) as EvaluationInput;
    return c.json(await evaluateLocally(input, rt.llm, rt.cfg.llmUrl));
  });
  app.post("/stt", async (c) => {
    if (!rt.stt.ready) return c.json({ error: "stt not ready" }, 503);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const language = c.req.query("language") ?? "ja-JP";
    const text = await rt.stt.transcribe(pcm16BytesToFloat32(bytes), 16000, language);
    return c.json({ text });
  });
  return app;
}

export function attachSessionWs(server: ReturnType<typeof createServer>, rt: AgentRuntime, log = (m: string) => console.log("[agent]", m)): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  let strictSessions = 0;
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/session") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws: WebSocket) => {
    const session = new ConversationSession({
      stt: rt.stt,
      vad: rt.createVad(),
      llm: rt.llm,
      tts: rt.tts,
      turn: rt.turn ?? undefined,
      send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
      sendAudio: (frame) => ws.readyState === ws.OPEN && ws.send(frame, { binary: true }),
      nonLoopbackEndpoints: () => nonLoopbackEndpoints(rt.cfg),
      streamingStt: rt.createStreamingStt ?? undefined,
      finalStt: rt.finalStt,
      endpointing: rt.cfg.endpoint,
      onStrictLocal: (active) => {
        strictSessions += active ? 1 : -1;
        setStrictEgressBlock(strictSessions > 0);
      },
      log,
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        session.onAudio(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        return;
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "invalid json" }));
        return;
      }
      switch (msg.type) {
        case "start":
          session.start(msg.config);
          break;
        case "text":
          void session.onText(msg.text);
          break;
        case "interrupt":
          session.interrupt();
          break;
        case "update_context":
          session.updateContext(msg.context);
          break;
        case "stop":
          session.stop();
          ws.close();
          break;
      }
    });
    ws.on("close", () => session.stop());
  });
  return wss;
}

export async function startAgent(cfg: AgentConfig = loadConfig()): Promise<{ server: ReturnType<typeof createServer>; rt: AgentRuntime; close(): Promise<void> }> {
  installEgressGuard();
  const rt = await createRuntime(cfg);
  const app = createApp(rt);
  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: "127.0.0.1", createServer }) as ReturnType<typeof createServer>;
  const wss = attachSessionWs(server, rt);
  console.log(`[agent] listening on http://127.0.0.1:${cfg.port}  stt=${rt.stt.engine}(${rt.stt.ready ? "ready" : "NOT READY"}) llm=${rt.llm.model}(${rt.llm.ready ? "ready" : "NOT READY"}) tts=${rt.tts.engine} vad=${rt.vadEngine}`);
  return {
    server,
    rt,
    close: () =>
      new Promise((resolve) => {
        wss.close();
        server.close(() => resolve());
      }),
  };
}

const isMain = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  startAgent().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
