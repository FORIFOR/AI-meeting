import type { ConversationContext, SessionConfig, TurnMetrics } from "@rcai/conversation-core";
import type { STTAdapter } from "./adapters/stt.js";
import type { StreamingSTT } from "./adapters/stt-streaming.js";
import type { VADAdapter } from "./adapters/vad.js";
import { EndpointPolicy, type EndpointPolicyOptions } from "./endpointing.js";
import type { ChatMessage, LLMAdapter } from "./adapters/llm.js";
import type { TTSAdapter, TTSResult } from "./adapters/tts.js";
import { PROTOCOL_VERSION, encodeAudioFrame, pcm16BytesToFloat32, type ServerMessage, type WireGen } from "./protocol.js";
import { SentenceChunker, endsSentence, stripMarkdown } from "./sentence.js";
import { AsyncQueue } from "./queue.js";

/** How much audio before `speech_start` is replayed into the recogniser (400 ms @ 16 kHz). */
const PREROLL_SAMPLES = 6400;

export { AsyncQueue } from "./queue.js";

export interface SessionDeps {
  stt: STTAdapter;
  vad: VADAdapter;
  llm: LLMAdapter;
  tts: TTSAdapter;
  send(msg: ServerMessage): void;
  sendAudio(frame: Uint8Array): void;
  /** Called with `true` when a strict_local session starts and `false` when it ends. */
  onStrictLocal?(active: boolean): void;
  /** Reject config under strict_local if any adapter endpoint is not loopback. */
  nonLoopbackEndpoints?(): string[];
  clock?: () => number;
  /** Max ms of audio the client may hold ahead of real time (pacing). Default 600. */
  leadMs?: number;
  /** Output chunk size in ms. Default 40. */
  chunkMs?: number;
  /** LLM max tokens per reply. Default 120 (replies are 1–3 sentences by policy). */
  maxTokens?: number;
  log?: (msg: string) => void;
  /** Called with the per-turn breakdown after each assistant turn (also sent to the client). */
  onMetrics?(turn: TurnMetrics): void;
  // ---- Round 3 (Gate 3/4): streaming STT + adaptive endpointing. Absent ⇒ baseline path (Gate 6). ----
  /** Per-session streaming recognizer factory (incremental re-decode or true online). */
  streamingStt?(): StreamingSTT;
  /** Endpoint policy options; the policy is enabled only when `streamingStt` is provided. */
  endpointing?: EndpointPolicyOptions;
  /** The user resumed within this many ms of an endpoint ⇒ the endpoint was premature. Default 1200. */
  prematureWindowMs?: number;
}

export type SessionState = "idle" | "listening" | "thinking" | "speaking";

/** Mutable per-turn timing record (all wall-clock ms from `clock`). */
interface TurnClock {
  source: "speech" | "text";
  speechEndAt: number; // VAD decision (or text arrival)
  vadEndMs?: number;
  transcriptAt?: number;
  llmStartAt?: number;
  firstTokenAt?: number;
  firstPhraseAt?: number;
  firstTtsAudioAt?: number;
  firstAudioSentAt?: number;
  lastAudioSentAt?: number;
  phrases: number;
  sentences: number;
  /** True end of the user's audio (VAD segment end, corrected for the VAD's own lag). */
  segmentEndAt?: number;
  endpointReason?: string;
  endpointSilenceMs?: number;
  sttReused?: boolean;
  sttPartials?: number;
  prematureEndpoint?: boolean;
}

/** An utterance being collected across VAD pauses (incremental/online modes). */
interface Utterance {
  seq: number;
  startedAt: number;
  segments: Float32Array[];
  /** Wall-clock end of the last VAD segment (pause start). */
  segmentEndAt: number;
  /** Timer that re-evaluates the endpoint as silence grows. */
  timer: ReturnType<typeof setTimeout> | null;
  vadEndLagMs?: number;
  /** Text of a premature previous turn to merge into this one. */
  prefix: string;
}

/**
 * One local-bus conversation: VAD → STT → LLM (streamed) → TTS (streamed per phrase) → paced audio.
 * Barge-in: VAD speech start while thinking/speaking aborts everything and emits `interrupted`.
 * Every assistant turn ends with a `metrics` message carrying the stage breakdown (P0-3).
 */
export class ConversationSession {
  state: SessionState = "idle";
  private history: ChatMessage[] = [];
  private systemPrompt = "";
  private language = "ja-JP";
  private strictLocal = false;
  private abort: AbortController | null = null;
  private started = false;
  private turnSeq = 0;
  private clock: () => number;
  /** Generation epoch (Round 3 Gate 1): provider-owned counters stamped on every assistant message. */
  private gen = { turnId: 0, generationId: 0, sequence: 0 };
  /** Only this generation may emit; anything else is a late chunk and is dropped server-side. */
  private activeGeneration = 0;
  /** Observability: assistant messages/audio dropped because their generation was cancelled. */
  staleDropsServer = 0;
  // ---- Round 3 input side ----
  private streamingStt: StreamingSTT | null = null;
  private policy: EndpointPolicy | null = null;
  private utterance: Utterance | null = null;
  private utteranceSeq = 0;
  /** Last committed endpoint (for premature detection + text merge). */
  private lastEndpoint: { at: number; text: string; userHistoryIndex: number } | null = null;
  private pendingPrefix = "";
  /**
   * Onset pre-roll for the streaming path. Silero only reports `speech_start` after ~80 ms of speech
   * plus its own window latency, and until then nothing was handed to the recogniser — so the first
   * mora was silently dropped (「ゆいさん」 came back as 「ゆさん」, which is exactly the word the
   * character is listening for). Keep the recent audio and replay it when the utterance opens.
   */
  private preroll: Float32Array[] = [];
  private prerollSamples = 0;
  readonly sessionStats = { turns: 0, prematureEndpoints: 0, bargeIns: 0 };

  constructor(private readonly deps: SessionDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  start(config: SessionConfig): void {
    this.systemPrompt = config.systemPrompt;
    this.language = config.language ?? "ja-JP";
    this.strictLocal = config.privacyMode === "strict_local";
    if (this.strictLocal) {
      const bad = this.deps.nonLoopbackEndpoints?.() ?? [];
      if (bad.length) {
        this.deps.send({ type: "error", message: `strict_local rejected non-loopback endpoints: ${bad.join(", ")}` });
        return;
      }
      this.deps.onStrictLocal?.(true);
    }
    this.history = [];
    this.started = true;
    if (this.deps.streamingStt) {
      this.streamingStt = this.deps.streamingStt();
      this.streamingStt.start(this.language);
      this.policy = new EndpointPolicy({ language: this.language, ...this.deps.endpointing });
    }
    this.deps.send({ type: "ready", stt: this.deps.stt.engine, llm: `${this.deps.llm.engine}:${this.deps.llm.model}`, tts: this.deps.tts.engine, protocolVersion: PROTOCOL_VERSION });
    const opening = (config.providerOptions as { opening?: string } | undefined)?.opening;
    if (opening) void this.speakOnly(opening);
  }

  /** Client audio: Int16 LE PCM @ 16 kHz. */
  onAudio(bytes: Uint8Array): void {
    if (!this.started) return;
    const samples = pcm16BytesToFloat32(bytes);
    const at = this.clock();
    if (this.policy && this.streamingStt) {
      this.onAudioStreaming(samples, at);
      return;
    }
    for (const ev of this.deps.vad.process(samples, at)) {
      if (ev.type === "speech_start") {
        if (this.state === "speaking" || this.state === "thinking") this.interrupt("barge-in");
        this.state = "listening";
        this.deps.send({ type: "user_speech_started" });
      } else {
        if (this.state !== "listening") continue;
        this.deps.send({ type: "user_speech_ended" });
        this.state = "thinking";
        const turn: TurnClock = {
          source: "speech",
          speechEndAt: at,
          vadEndMs: ev.endLagSamples !== undefined ? Math.round((ev.endLagSamples / 16000) * 1000) : undefined,
          phrases: 0,
          sentences: 0,
        };
        void this.runTurn(ev.samples, turn);
      }
    }
  }

  // ---- Round 3: streaming STT + endpoint policy (input side) -----------------

  /**
   * The VAD runs with a short pause threshold (~200 ms). Every pause yields a segment that is
   * appended to the current utterance; the endpoint policy then decides from silence + transcript
   * whether the turn is over. Resumed speech cancels the pending endpoint (no event reaches the
   * client, so the avatar simply keeps LISTENING).
   */
  private onAudioStreaming(samples: Float32Array, at: number): void {
    const stt = this.streamingStt!;
    if (this.utterance || this.deps.vad.speaking) stt.pushAudio(samples);
    else this.rememberPreroll(samples);
    for (const ev of this.deps.vad.process(samples, at)) {
      if (ev.type === "speech_start") {
        if (this.state === "speaking" || this.state === "thinking") {
          this.sessionStats.bargeIns++;
          const le = this.lastEndpoint;
          if (le && at - le.at < (this.deps.prematureWindowMs ?? 1200)) {
            // We ended the turn too early: adapt, and merge the text into the next turn.
            this.sessionStats.prematureEndpoints++;
            this.policy!.notePrematureEndpoint();
            this.pendingPrefix = le.text;
            if (this.history[le.userHistoryIndex]?.role === "user") this.history.splice(le.userHistoryIndex, 1);
            this.deps.log?.(`premature endpoint (${at - le.at}ms) → merging "${le.text.slice(0, 20)}…"`);
          }
          this.interrupt("barge-in");
        }
        if (this.utterance) {
          // Pause ended: the user is still talking — cancel the pending endpoint.
          if (this.utterance.timer) clearTimeout(this.utterance.timer);
          this.utterance.timer = null;
        } else {
          this.utterance = { seq: ++this.utteranceSeq, startedAt: at, segments: [], segmentEndAt: at, timer: null, prefix: this.pendingPrefix };
          this.pendingPrefix = "";
          stt.start(this.language);
          this.flushPreroll(stt);
          this.state = "listening";
          this.deps.send({ type: "user_speech_started" });
        }
      } else if (this.utterance) {
        const u = this.utterance;
        u.segments.push(ev.samples);
        const lagMs = ev.endLagSamples !== undefined ? Math.round((ev.endLagSamples / 16000) * 1000) : 0;
        u.segmentEndAt = at - lagMs;
        u.vadEndLagMs = lagMs;
        void this.evaluateEndpoint(u);
      }
    }
  }

  /** Ring buffer of the audio just before the VAD made up its mind (PREROLL_MS). */
  private rememberPreroll(samples: Float32Array): void {
    this.preroll.push(samples);
    this.prerollSamples += samples.length;
    while (this.prerollSamples > PREROLL_SAMPLES && this.preroll.length > 1) {
      this.prerollSamples -= this.preroll.shift()!.length;
    }
  }

  private flushPreroll(stt: { pushAudio(s: Float32Array): void }): void {
    for (const chunk of this.preroll) stt.pushAudio(chunk);
    this.preroll = [];
    this.prerollSamples = 0;
  }

  private async evaluateEndpoint(u: Utterance): Promise<void> {
    if (this.utterance !== u || u.timer) return;
    const stt = this.streamingStt!;
    const policy = this.policy!;
    const t0 = this.clock();
    // fresh partial (or reused when the last decode already covers the speech; the pause itself is silence)
    const snap = await stt.snapshot({ trailingSilenceMs: this.clock() - u.segmentEndAt });
    const sttMs = this.clock() - t0;
    if (this.utterance !== u) return; // superseded (new speech / stop)
    const stable = stt.isStable;
    const text = (u.prefix ? `${u.prefix} ` : "") + snap.text;
    const silenceMs = this.clock() - u.segmentEndAt;
    const d = policy.evaluate({ speaking: this.deps.vad.speaking, silenceMs, text, stable });
    this.deps.log?.(`endpoint? silence=${silenceMs}ms stt=${sttMs}ms reused=${snap.reused ? 1 : 0} "${snap.text.slice(-12)}" → ${d.decision}/${d.reason} need=${d.requiredSilenceMs}`);
    if (d.decision === "endpoint") {
      void this.commitTurn(u, text, { reason: d.reason, requiredSilenceMs: d.requiredSilenceMs, sttMs, reused: Boolean(snap.reused) });
      return;
    }
    u.timer = setTimeout(() => {
      u.timer = null;
      if (this.utterance !== u) return;
      const silence = this.clock() - u.segmentEndAt;
      const again = policy.evaluate({ speaking: this.deps.vad.speaking, silenceMs: silence, text, stable: true });
      if (again.decision === "endpoint") void this.commitTurn(u, text, { reason: again.reason, requiredSilenceMs: again.requiredSilenceMs, sttMs: 0, reused: true });
      else void this.evaluateEndpoint(u); // still waiting: re-evaluate later (max_silence is the hard cap)
    }, d.waitMs);
  }

  private async commitTurn(u: Utterance, text: string, ep: { reason: string; requiredSilenceMs: number; sttMs: number; reused: boolean }): Promise<void> {
    if (this.utterance !== u) return;
    this.utterance = null;
    const stt = this.streamingStt!;
    const final = await stt.endUtterance();
    if (this.utterance !== null) return; // new speech arrived while finalising
    const at = this.clock();
    this.deps.send({ type: "user_speech_ended" });
    this.state = "thinking";
    this.policy!.noteCleanEndpoint(); // provisional; a barge-in within the premature window revises it
    const merged = (u.prefix ? `${u.prefix} ` : "") + (final.text || text.replace(u.prefix, "").trim());
    const turn: TurnClock = {
      source: "speech",
      speechEndAt: at,
      segmentEndAt: u.segmentEndAt,
      vadEndMs: at - u.segmentEndAt,
      transcriptAt: at,
      phrases: 0,
      sentences: 0,
      endpointReason: ep.reason,
      endpointSilenceMs: ep.requiredSilenceMs,
      sttReused: ep.reused && Boolean(final.reused),
      sttPartials: stt.partials,
      prematureEndpoint: u.prefix.length > 0,
    };
    this.sessionStats.turns++;
    if (!merged.trim()) {
      this.state = "idle";
      return;
    }
    this.deps.send({ type: "user_transcript", text: merged, final: true });
    this.lastEndpoint = { at, text: merged, userHistoryIndex: this.history.length };
    await this.respond(merged, turn);
  }

  async onText(text: string): Promise<void> {
    if (!this.started) return;
    if (this.state === "speaking" || this.state === "thinking") this.interrupt("text");
    this.deps.send({ type: "user_transcript", text, final: true });
    await this.respond(text, { source: "text", speechEndAt: this.clock(), phrases: 0, sentences: 0 });
  }

  interrupt(reason = "client"): void {
    if (!this.abort) return;
    this.deps.log?.(`interrupt (${reason}) gen=${this.activeGeneration}`);
    this.abort.abort();
    this.abort = null;
    // Cancel order: abort LLM/TTS → close the generation (late chunks become stale) → tell the client.
    const cancelled: WireGen = { turnId: this.gen.turnId, generationId: this.activeGeneration, sequence: this.gen.sequence };
    this.activeGeneration = 0;
    this.deps.send({ type: "interrupted", gen: cancelled });
    this.state = "idle";
  }

  // ---- generation epoch helpers ---------------------------------------------

  /** Opens a new assistant generation (called at the start of every response / opening line). */
  private beginGeneration(newTurn: boolean): number {
    if (newTurn) this.gen.turnId++;
    this.gen.generationId++;
    this.gen.sequence = 0;
    this.activeGeneration = this.gen.generationId;
    return this.activeGeneration;
  }

  private stamp(): WireGen {
    return { turnId: this.gen.turnId, generationId: this.gen.generationId, sequence: this.gen.sequence++ };
  }

  /** Send an assistant-side message iff `genId` is still the active generation. */
  private sendGen(genId: number, msg: Exclude<ServerMessage, { type: "ready" | "user_speech_started" | "user_speech_ended" | "user_transcript" | "error" | "interrupted" }>): boolean {
    if (genId !== this.activeGeneration) {
      this.staleDropsServer++;
      this.deps.log?.(`drop stale ${msg.type} gen=${genId} active=${this.activeGeneration}`);
      return false;
    }
    this.deps.send({ ...msg, gen: this.stamp() });
    return true;
  }

  private sendAudioGen(genId: number, sampleRate: number, pcm16: Int16Array): boolean {
    if (genId !== this.activeGeneration) {
      this.staleDropsServer++;
      return false;
    }
    this.deps.sendAudio(encodeAudioFrame(sampleRate, pcm16, this.stamp()));
    return true;
  }

  updateContext(ctx: ConversationContext): void {
    this.systemPrompt = ctx.systemPrompt;
    if (ctx.history) this.history = ctx.history.map((h) => ({ role: h.role, content: h.text }));
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.utterance?.timer) clearTimeout(this.utterance.timer);
    this.utterance = null;
    this.preroll = [];
    this.prerollSamples = 0;
    this.streamingStt?.reset();
    if (this.strictLocal) {
      this.deps.onStrictLocal?.(false); // exactly once per strict session (stop + ws close both call stop())
      this.strictLocal = false;
    }
    this.started = false;
    this.state = "idle";
  }

  // ---- pipeline ------------------------------------------------------------

  private async runTurn(samples: Float32Array, turn: TurnClock): Promise<void> {
    const seq = ++this.turnSeq;
    let text = "";
    try {
      const t0 = this.clock();
      text = await this.deps.stt.transcribe(samples, 16000, this.language);
      turn.transcriptAt = this.clock();
      this.deps.log?.(`stt ${turn.transcriptAt - t0}ms "${text}"`);
    } catch (err) {
      this.deps.send({ type: "error", message: `stt: ${(err as Error).message}` });
    }
    if (seq !== this.turnSeq || this.state !== "thinking") return; // superseded by newer speech
    if (!text) {
      this.state = "idle";
      return;
    }
    this.deps.send({ type: "user_transcript", text, final: true });
    await this.respond(text, turn);
  }

  private async respond(userText: string, turn: TurnClock): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.state = "thinking";
    const genId = this.beginGeneration(true);
    this.sendGen(genId, { type: "assistant_thinking" });
    this.history.push({ role: "user", content: userText });
    const messages: ChatMessage[] = [{ role: "system", content: this.systemPrompt }, ...this.history.slice(-12)];
    const chunker = new SentenceChunker();
    const queue = new AsyncQueue<string>();
    let full = "";
    const speakTask = this.speakQueue(queue, abort.signal, turn, genId);
    turn.llmStartAt = this.clock();
    const pushChunk = (s: string) => {
      const clean = stripMarkdown(s).trim();
      if (!clean) return; // e.g. an emoji-only "sentence"
      if (!turn.firstPhraseAt) turn.firstPhraseAt = this.clock();
      turn.phrases++;
      if (endsSentence(clean)) turn.sentences++;
      queue.push(clean);
    };
    try {
      for await (const delta of this.deps.llm.stream(messages, { maxTokens: this.deps.maxTokens ?? 120, temperature: 0.7, signal: abort.signal })) {
        if (abort.signal.aborted) break;
        if (!turn.firstTokenAt) turn.firstTokenAt = this.clock();
        full += delta;
        for (const s of chunker.push(delta)) pushChunk(s);
      }
      const rest = chunker.flush();
      if (rest) pushChunk(rest);
      this.deps.log?.(`llm first-token ${(turn.firstTokenAt ?? 0) - turn.llmStartAt}ms first-phrase ${(turn.firstPhraseAt ?? 0) - turn.llmStartAt}ms total ${this.clock() - turn.llmStartAt}ms`);
    } catch (err) {
      if (!abort.signal.aborted) this.deps.send({ type: "error", message: `llm: ${(err as Error).message}` });
    } finally {
      queue.close();
    }
    const spoke = await speakTask;
    if (abort.signal.aborted || genId !== this.activeGeneration) return;
    const finalText = stripMarkdown(full).trim();
    if (finalText) this.history.push({ role: "assistant", content: finalText });
    this.deps.log?.(`reply "${finalText}"${spoke ? " (spoken)" : " (no audio)"}`);
    this.sendGen(genId, { type: "assistant_transcript", text: finalText, final: true });
    if (spoke) this.sendGen(genId, { type: "assistant_speech_ended" });
    this.reportMetrics(turn, genId);
    this.abort = null;
    this.state = "idle";
  }

  /** Speak a fixed line (persona opening). */
  private async speakOnly(text: string): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.state = "speaking";
    const genId = this.beginGeneration(false);
    const queue = new AsyncQueue<string>();
    const chunker = new SentenceChunker();
    for (const s of chunker.push(text)) queue.push(s);
    const rest = chunker.flush();
    if (rest) queue.push(rest);
    queue.close();
    const spoke = await this.speakQueue(queue, abort.signal, { source: "text", speechEndAt: this.clock(), phrases: 0, sentences: 0 }, genId);
    if (abort.signal.aborted || genId !== this.activeGeneration) return;
    this.history.push({ role: "assistant", content: text });
    this.sendGen(genId, { type: "assistant_transcript", text, final: true });
    if (spoke) this.sendGen(genId, { type: "assistant_speech_ended" });
    this.abort = null;
    this.state = "idle";
  }

  private reportMetrics(turn: TurnClock, genId: number): void {
    const m: TurnMetrics = {
      source: turn.source,
      vadEndMs: turn.vadEndMs,
      sttMs: turn.transcriptAt !== undefined ? turn.transcriptAt - turn.speechEndAt : undefined,
      llmTtftMs: turn.firstTokenAt !== undefined && turn.llmStartAt !== undefined ? turn.firstTokenAt - turn.llmStartAt : undefined,
      firstPhraseMs: turn.firstPhraseAt !== undefined && turn.llmStartAt !== undefined ? turn.firstPhraseAt - turn.llmStartAt : undefined,
      ttsTtfaMs: turn.firstTtsAudioAt !== undefined && turn.firstPhraseAt !== undefined ? turn.firstTtsAudioAt - turn.firstPhraseAt : undefined,
      firstAudioSentMs: turn.firstAudioSentAt !== undefined ? turn.firstAudioSentAt - turn.speechEndAt : undefined,
      totalMs: turn.lastAudioSentAt !== undefined ? turn.lastAudioSentAt - turn.speechEndAt : undefined,
      phrases: turn.phrases,
      sentences: turn.sentences,
      engines: { vad: this.deps.vad.engine, stt: this.streamingStt?.engine ?? this.deps.stt.engine, llm: `${this.deps.llm.engine}:${this.deps.llm.model}`, tts: this.deps.tts.engine },
      endpointReason: turn.endpointReason ?? (turn.source === "speech" ? "baseline_vad" : undefined),
      endpointSilenceMs: turn.endpointSilenceMs,
      endToFirstAudioMs: turn.firstAudioSentAt !== undefined && turn.segmentEndAt !== undefined ? turn.firstAudioSentAt - turn.segmentEndAt : turn.firstAudioSentAt !== undefined && turn.vadEndMs !== undefined ? turn.firstAudioSentAt - turn.speechEndAt + turn.vadEndMs : undefined,
      sttReused: turn.sttReused,
      sttPartials: turn.sttPartials,
      prematureEndpoint: turn.prematureEndpoint,
      session: {
        turns: this.sessionStats.turns,
        prematureEndpoints: this.sessionStats.prematureEndpoints,
        prematureEndpointRate: this.sessionStats.turns ? this.sessionStats.prematureEndpoints / this.sessionStats.turns : 0,
        bargeIns: this.sessionStats.bargeIns,
        userBargeInRate: this.sessionStats.turns ? this.sessionStats.bargeIns / this.sessionStats.turns : 0,
      },
    };
    this.deps.log?.(`[metrics] ${JSON.stringify(m)}`);
    this.sendGen(genId, { type: "metrics", turn: m });
    this.deps.onMetrics?.(m);
  }

  /** Wrap an adapter into a chunk stream (streaming adapters yield as they synthesize). */
  private ttsStream(text: string, signal: AbortSignal): AsyncIterable<TTSResult> {
    const tts = this.deps.tts;
    if (tts.synthesizeStream) return tts.synthesizeStream(text, signal);
    // The request is issued now (lookahead); a rejection before iteration (e.g. abort) must not
    // surface as an unhandled promise rejection, so it is captured and re-thrown to the consumer.
    const p = tts.synthesize(text, signal).then((r) => ({ ok: true as const, r }), (err: unknown) => ({ ok: false as const, err }));
    return {
      async *[Symbol.asyncIterator]() {
        const res = await p;
        if (!res.ok) throw res.err instanceof Error ? res.err : new Error(String(res.err));
        yield res.r;
      },
    };
  }

  /**
   * Consume phrases: TTS for the next phrase is requested as soon as it arrives (lookahead), audio
   * chunks are re-framed to `chunkMs` and paced so the client never holds more than `leadMs`.
   * Returns true if any audio was sent.
   */
  private async speakQueue(queue: AsyncQueue<string>, signal: AbortSignal, turn: TurnClock, genId: number): Promise<boolean> {
    let spoke = false;
    let startedAt = 0;
    let sentMs = 0;
    const chunkMs = this.deps.chunkMs ?? 40;
    const leadMs = this.deps.leadMs ?? 600;

    const take = async (): Promise<{ phrase: string; stream: AsyncIterable<TTSResult>; requestedAt: number } | null> => {
      const s = await queue.next();
      if (s === null) return null;
      try {
        return { phrase: s, stream: this.ttsStream(s, signal), requestedAt: this.clock() };
      } catch (err) {
        if (!signal.aborted) this.deps.send({ type: "error", message: `tts: ${(err as Error).message}` });
        return { phrase: s, stream: { async *[Symbol.asyncIterator]() {} }, requestedAt: this.clock() };
      }
    };

    const sendPcm = async (sampleRate: number, pcm16: Int16Array): Promise<void> => {
      const lead = sentMs - (this.clock() - startedAt);
      if (lead > leadMs) await sleep(lead - leadMs, signal);
      if (signal.aborted) return;
      if (!this.sendAudioGen(genId, sampleRate, pcm16)) return; // cancelled generation: late chunk dropped
      const now = this.clock();
      if (!turn.firstAudioSentAt) turn.firstAudioSentAt = now;
      turn.lastAudioSentAt = now;
      sentMs += (pcm16.length / sampleRate) * 1000;
    };

    let pending = await take();
    while (pending) {
      const nextP = take(); // requests the following phrase now (daemon queues it; say/sbv2 synthesize in parallel)
      let transcriptSent = false;
      let acc: Int16Array[] = [];
      let accLen = 0;
      let rate = 0;
      const t0 = this.clock();
      try {
        for await (const chunk of pending.stream) {
          if (signal.aborted) return spoke;
          if (chunk.pcm16.length === 0) continue;
          if (!spoke) {
            spoke = true;
            this.state = "speaking";
            if (!this.sendGen(genId, { type: "assistant_speech_started" })) return spoke;
            startedAt = this.clock();
          }
          if (!turn.firstTtsAudioAt) turn.firstTtsAudioAt = this.clock();
          if (!transcriptSent) {
            transcriptSent = true;
            this.sendGen(genId, { type: "assistant_transcript", text: pending.phrase, final: false });
          }
          rate = chunk.sampleRate;
          acc.push(chunk.pcm16);
          accLen += chunk.pcm16.length;
          const frame = Math.round((chunkMs / 1000) * rate);
          while (accLen >= frame) {
            const merged = mergeInt16(acc, accLen);
            acc = [merged.subarray(frame)];
            accLen = acc[0]!.length;
            await sendPcm(rate, merged.subarray(0, frame));
            if (signal.aborted) return spoke;
          }
        }
        if (accLen > 0 && rate > 0) await sendPcm(rate, mergeInt16(acc, accLen));
        this.deps.log?.(`tts ${this.clock() - t0}ms (req→done) "${pending.phrase.slice(0, 20)}"`);
      } catch (err) {
        if (!signal.aborted) this.deps.send({ type: "error", message: `tts: ${(err as Error).message}` });
      }
      if (signal.aborted) return spoke;
      pending = await nextP;
    }
    // Let the client finish playing before we report the end (keeps the barge-in window honest).
    const remaining = sentMs - (this.clock() - startedAt);
    if (spoke && remaining > 0) await sleep(remaining, signal);
    return spoke;
  }
}

function mergeInt16(parts: Int16Array[], total: number): Int16Array {
  if (parts.length === 1 && parts[0]!.length === total) return parts[0]!;
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { signal?.removeEventListener("abort", done); clearTimeout(t); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}
