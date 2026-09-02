import type { ConversationContext, SessionConfig, TurnMetrics } from "@rcai/conversation-core";
import type { STTAdapter } from "./adapters/stt.js";
import type { StreamingSTT } from "./adapters/stt-streaming.js";
import type { VADAdapter } from "./adapters/vad.js";
import { EndpointPolicy, type EndpointPolicyOptions } from "./endpointing.js";
import { ConversationMemory } from "./memory.js";
import type { ChatMessage, LLMAdapter } from "./adapters/llm.js";
import type { TTSAdapter, TTSResult } from "./adapters/tts.js";
import { PROTOCOL_VERSION, encodeAudioFrame, pcm16BytesToFloat32, type ServerMessage, type WireGen } from "./protocol.js";
import { SentenceChunker, endsSentence, stripMarkdown } from "./sentence.js";
import { AsyncQueue } from "./queue.js";

/**
 * How much audio before `speech_start` is replayed into the recogniser (400 ms @ 16 kHz).
 * Measured: 400 ms recovers the onset the VAD needed to decide; 800 ms started feeding the recogniser
 * enough room tone to hurt it elsewhere (「手伝って」→「手学って」).
 */
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
  /**
   * Characters of recent conversation the model sees verbatim; older turns are folded into notes
   * (see ConversationMemory). Default 2400 — sized for a 4k-context local model; a cloud model can
   * take far more.
   */
  historyChars?: number;
  log?: (msg: string) => void;
  /** Called with the per-turn breakdown after each assistant turn (also sent to the client). */
  onMetrics?(turn: TurnMetrics): void;
  // ---- Round 3 (Gate 3/4): streaming STT + adaptive endpointing. Absent ⇒ baseline path (Gate 6). ----
  /** Per-session streaming recognizer factory (incremental re-decode or true online). */
  streamingStt?(): StreamingSTT;
  /** Endpoint policy options; the policy is enabled only when `streamingStt` is provided. */
  endpointing?: EndpointPolicyOptions;
  /** Short pre-rendered syllables to cover a long think. Empty disables them. */
  fillers?: string[];
  /** Default when the persona says nothing about backchannels. */
  fillersEnabled?: boolean;
  /** How long to wait for the model before covering the gap (ms). Default 400. */
  fillerAfterMs?: number;
  /** Acoustic turn-end model. Absent ⇒ endpointing is silence + text only. */
  turn?: { readonly ready: boolean; predict(samples: Float32Array): Promise<{ probability: number; complete: boolean } | null> };
  /** The user resumed within this many ms of an endpoint ⇒ the endpoint was premature. Default 1200. */
  prematureWindowMs?: number;
  /**
   * Second-pass recogniser for the committed utterance. The streaming recogniser has to answer while the
   * user is still talking, so it trades accuracy for latency — on Japanese it mangles exactly the words a
   * character is listening for (「ゆいさん」→「ういさん」). Re-decoding the finished utterance with a
   * stronger model costs a few hundred ms once per turn and fixes the text the LLM actually reads.
   */
  finalStt?: STTAdapter | null;
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
  /** Last acoustic turn-completeness for this utterance, and when it was measured. */
  acoustic?: number;
  acousticAt?: number;
  /** Wall-clock end of the last VAD segment (pause start). */
  segmentEndAt: number;
  /** Timer that re-evaluates the endpoint as silence grows. */
  timer: ReturnType<typeof setTimeout> | null;
  vadEndLagMs?: number;
  /** Text of a premature previous turn to merge into this one. */
  prefix: string;
  /** Exactly the audio handed to the streaming recogniser, for the optional second pass. */
  audio: Float32Array[];
}

/**
 * One local-bus conversation: VAD → STT → LLM (streamed) → TTS (streamed per phrase) → paced audio.
 * Barge-in: VAD speech start while thinking/speaking aborts everything and emits `interrupted`.
 * Every assistant turn ends with a `metrics` message carrying the stage breakdown (P0-3).
 */
export class ConversationSession {
  state: SessionState = "idle";
  private history: ChatMessage[] = [];
  private memory = new ConversationMemory({ recentChars: 2400 });
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
  private lastEndpoint: { at: number; text: string; userHistoryIndex: number; audio: Float32Array[] } | null = null;
  private pendingPrefix = "";
  /** Audio of a premature previous turn, prepended to the next utterance for the final decode. */
  private pendingAudio: Float32Array[] = [];
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

  /** Voice chosen by the user for this session; undefined keeps the adapter's configured voice. */
  private voice?: string;

  /**
   * Pre-rendered 「えーっと、」-class syllables, in the character's own voice.
   *
   * Rendered once when a session starts, so playing one costs a buffer copy rather than a synthesis.
   * They are the only audio in the system that is allowed to be spoken without the model having said
   * anything, which is why the rules around them are strict: never twice in a row, never when the
   * persona has backchannels off, and never once the real first phrase has arrived.
   */
  private filler = {
    clips: [] as { sampleRate: number; pcm16: Int16Array }[],
    next: 0,
    lastGen: -1,
    enabled: false,
    get armed(): boolean {
      return this.enabled && this.clips.length > 0;
    },
    play: (_genId: number) => {},
  };

  /** Render the fillers for this session's voice, in the background: a turn must not wait for them. */
  private primeFillers(): void {
    const phrases = this.deps.fillers ?? (this.language.toLowerCase().startsWith("en") ? ["Um,", "Hmm,", "Well,"] : ["えーっと、", "うーん、", "そうですね、"]);
    this.filler.clips = [];
    this.filler.next = 0;
    void (async () => {
      for (const phrase of phrases) {
        try {
          const r = await this.deps.tts.synthesize(phrase, undefined, this.voice, this.language);
          if (r.pcm16.length) this.filler.clips.push(r);
        } catch {
          // A voice that cannot say 「えーっと」 simply does not get fillers.
        }
      }
    })();
    this.filler.play = (genId: number) => {
      if (this.filler.lastGen === genId || !this.filler.clips.length) return;
      this.filler.lastGen = genId;
      const clip = this.filler.clips[this.filler.next++ % this.filler.clips.length]!;
      this.sendAudioGen(genId, clip.sampleRate, clip.pcm16);
    };
  }

  start(config: SessionConfig): void {
    this.systemPrompt = config.systemPrompt;
    this.language = config.language ?? "ja-JP";
    this.strictLocal = config.privacyMode === "strict_local";
    this.voice = config.voice;
    // Backchannels are a persona decision; the session only supplies the audio.
    /**
     * Whether the character makes a small sound while it thinks is the same decision as whether it
     * uses backchannels at all, and the persona already carries that — as a value, not as a sentence
     * in the prompt.
     */
    const policy = (config.providerOptions as { turnPolicy?: { backchannel?: boolean } } | undefined)?.turnPolicy;
    this.filler.enabled = policy?.backchannel ?? this.deps.fillersEnabled ?? false;
    if (this.filler.enabled) this.primeFillers();
    if (this.strictLocal) {
      const bad = this.deps.nonLoopbackEndpoints?.() ?? [];
      if (bad.length) {
        this.deps.send({ type: "error", message: `strict_local rejected non-loopback endpoints: ${bad.join(", ")}` });
        return;
      }
      this.deps.onStrictLocal?.(true);
    }
    this.history = [];
    this.memory = new ConversationMemory({ recentChars: this.deps.historyChars ?? 2400, language: this.language });
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
    if (this.utterance || this.deps.vad.speaking) {
      stt.pushAudio(samples);
      this.utterance?.audio.push(samples);
    } else {
      this.rememberPreroll(samples);
    }
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
            // Carry the audio too: the second pass must see the whole sentence, not the half that
            // survived the split. 「ありがとう。ゆいさんは…」 paused before the name, and decoding only
            // the tail is how 「ゆい」 kept coming back as 「イ」.
            this.pendingAudio = le.audio;
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
          this.utterance = { seq: ++this.utteranceSeq, startedAt: at, segments: [], segmentEndAt: at, timer: null, prefix: this.pendingPrefix, audio: this.pendingAudio };
          this.pendingPrefix = "";
          this.pendingAudio = [];
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
    for (const chunk of this.preroll) {
      stt.pushAudio(chunk);
      this.utterance?.audio.push(chunk);
    }
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
    /**
     * Ask the acoustic model only once we are close to ending: it costs tens of milliseconds, and its
     * answer matters only at the moment silence alone would have ended the turn.
     */
    const acoustic = silenceMs >= 200 ? await this.acousticCompleteness(u) : undefined;
    if (this.utterance !== u) return;
    const d = policy.evaluate({ speaking: this.deps.vad.speaking, silenceMs, text, stable, acoustic });
    this.deps.log?.(`endpoint? silence=${silenceMs}ms stt=${sttMs}ms reused=${snap.reused ? 1 : 0} "${snap.text.slice(-12)}" → ${d.decision}/${d.reason} need=${d.requiredSilenceMs}`);
    if (d.decision === "endpoint") {
      void this.commitTurn(u, text, { reason: d.reason, requiredSilenceMs: d.requiredSilenceMs, sttMs, reused: Boolean(snap.reused) });
      return;
    }
    u.timer = setTimeout(() => {
      u.timer = null;
      if (this.utterance !== u) return;
      const silence = this.clock() - u.segmentEndAt;
      const again = policy.evaluate({ speaking: this.deps.vad.speaking, silenceMs: silence, text, stable: true, acoustic });
      if (again.decision === "endpoint") void this.commitTurn(u, text, { reason: again.reason, requiredSilenceMs: again.requiredSilenceMs, sttMs: 0, reused: true });
      else void this.evaluateEndpoint(u); // still waiting: re-evaluate later (max_silence is the hard cap)
    }, d.waitMs);
  }

  /**
   * The acoustic view of "have they finished", over this utterance's own audio.
   *
   * Cached per evaluation round rather than per call: at 8 s of context the answer does not change
   * between two checks 100 ms apart, and the model is the expensive part of the loop.
   */
  private async acousticCompleteness(u: Utterance): Promise<number | undefined> {
    const turn = this.deps.turn;
    if (!turn?.ready || !u.segments.length) return undefined;
    if (u.acousticAt !== undefined && this.clock() - u.acousticAt < 400) return u.acoustic;
    let total = 0;
    for (const s of u.segments) total += s.length;
    const audio = new Float32Array(total);
    let off = 0;
    for (const s of u.segments) {
      audio.set(s, off);
      off += s.length;
    }
    const r = await turn.predict(audio);
    u.acoustic = r?.probability;
    u.acousticAt = this.clock();
    return u.acoustic;
  }

  /**
   * Second pass over the finished utterance. Returns the streaming text unchanged when no second
   * recogniser is configured, when it fails, or when it returns nothing — accuracy is worth a few
   * hundred ms, silence never is.
   */
  private async rescore(u: Utterance, streamed: string): Promise<string> {
    const second = this.deps.finalStt;
    if (!second?.ready || u.audio.length === 0) return streamed;
    const total = u.audio.reduce((n, a) => n + a.length, 0);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const a of u.audio) { pcm.set(a, o); o += a.length; }
    const t0 = this.clock();
    try {
      const text = (await second.transcribe(pcm, 16000, this.language)).trim();
      const ms = this.clock() - t0;
      if (!text) { this.deps.log?.(`rescore empty (${ms}ms) — keeping "${streamed}"`); return streamed; }
      if (text !== streamed) this.deps.log?.(`rescore ${ms}ms "${streamed}" → "${text}"`);
      return text;
    } catch (err) {
      this.deps.log?.(`rescore failed (${(err as Error).message}) — keeping the streaming text`);
      return streamed;
    }
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
    const streamed = final.text || text.replace(u.prefix, "").trim();
    const rescored = await this.rescore(u, streamed);
    // `rescore` decodes the whole utterance audio, prefix included, so it already covers the merged text.
    const merged = rescored !== streamed ? rescored : (u.prefix ? `${u.prefix} ` : "") + streamed;
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
    this.lastEndpoint = { at, text: merged, userHistoryIndex: this.history.length, audio: u.audio };
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
    if (ctx.history) {
      this.history = ctx.history.map((h) => ({ role: h.role, content: h.text }));
      this.memory.reset();
    }
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.memory.cancelFold();
    if (this.utterance?.timer) clearTimeout(this.utterance.timer);
    this.utterance = null;
    this.preroll = [];
    this.prerollSamples = 0;
    this.pendingAudio = [];
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
    this.memory.cancelFold(); // the model belongs to the reply now; the fold picks up again afterwards
    const messages = this.memory.compose(this.systemPrompt, this.history);
    const chunker = new SentenceChunker();
    const queue = new AsyncQueue<string>();
    let full = "";
    const speakTask = this.speakQueue(queue, abort.signal, turn, genId);
    turn.llmStartAt = this.clock();
    /**
     * A held syllable while the model thinks.
     *
     * People do this: asked something, they say 「えーっと、」 and start answering a beat later. The
     * character has the same problem — a cloud model needs ~650 ms before its first token and a
     * neural voice another ~300 ms — and the same solution, except that it can render the filler in
     * advance and start it in a few milliseconds.
     *
     * Only when the wait is actually long, never twice running, and only if the persona allows
     * backchannels: a character that says 「えーっと」 before every sentence has a verbal tic, which is
     * worse than a pause.
     */
    const fillerTimer = this.filler.enabled
      ? setTimeout(() => {
          // Checked here, not when the timer was set: pre-rendering takes a moment on a real engine,
          // and the first turn of a session is exactly when a long think is most likely.
          if (!abort.signal.aborted && !turn.firstPhraseAt && this.filler.armed) this.filler.play(genId);
        }, this.deps.fillerAfterMs ?? 400)
      : null;
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
      if (fillerTimer) clearTimeout(fillerTimer);
      this.deps.log?.(`llm first-token ${(turn.firstTokenAt ?? 0) - turn.llmStartAt}ms first-phrase ${(turn.firstPhraseAt ?? 0) - turn.llmStartAt}ms total ${this.clock() - turn.llmStartAt}ms`);
    } catch (err) {
      // Logged as well as sent: a failing model otherwise reads as `reply "" (no audio)` in the agent's
      // own log, which is indistinguishable from a model that had nothing to say.
      if (!abort.signal.aborted) {
        this.deps.log?.(`llm error: ${(err as Error).message}`);
        this.deps.send({ type: "error", message: `llm: ${(err as Error).message}` });
      }
    } finally {
      if (fillerTimer) clearTimeout(fillerTimer);
      queue.close();
      /**
       * Remember what was said as soon as it was said, not when it finished being spoken.
       *
       * Speech takes seconds; a person can start their next sentence during it, and every one of
       * those arrives at a model that cannot see its own last turn. Measured over five minutes of
       * conversation: the character greeted mid-conversation in 11 replies out of 29, because as far
       * as the model could tell each of them was the first thing it had ever said.
       *
       * A turn that was cut off counts too, and counts as what was actually reached — the room heard
       * that much, so the model has to know it. Without this an interrupted answer disappears and the
       * character starts it again from the top.
       */
      const said = stripMarkdown(full).trim();
      if (said && this.history[this.history.length - 1]?.role !== "assistant") {
        this.history.push({ role: "assistant", content: said });
      }
      // The model is idle while the voice speaks: fold what scrolled out of the window into the notes.
      void this.memory.fold(this.deps.llm, this.deps.log);
    }
    const spoke = await speakTask;
    if (abort.signal.aborted || genId !== this.activeGeneration) return;
    const finalText = stripMarkdown(full).trim();
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
    if (tts.synthesizeStream) return tts.synthesizeStream(text, signal, this.voice, this.language);
    // The request is issued now (lookahead); a rejection before iteration (e.g. abort) must not
    // surface as an unhandled promise rejection, so it is captured and re-thrown to the consumer.
    const p = tts.synthesize(text, signal, this.voice, this.language).then((r) => ({ ok: true as const, r }), (err: unknown) => ({ ok: false as const, err }));
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
