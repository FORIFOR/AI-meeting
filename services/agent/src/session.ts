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
import { rescoreRejection } from "./rescoreGuard.js";
import { encodeWav } from "./wav.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How much audio before `speech_start` is replayed into the recogniser (400 ms @ 16 kHz).
 * Measured: 400 ms recovers the onset the VAD needed to decide; 800 ms started feeding the recogniser
 * enough room tone to hurt it elsewhere (「手伝って」→「手学って」).
 */
const PREROLL_SAMPLES = 6400;

/**
 * What the character says when the model gave it nothing, in the order the failures come. The first
 * asks for a repeat, because a single miss usually is one; the second stops asking, because the
 * person already repeated themselves once; the third owns that it is off today and is the one that
 * repeats, at most once a turn, for as long as the hold lasts.
 */
const RECOVERY_LINES = [
  "ごめん、いま考えがまとまらなかった。もう一回言ってもらえる？",
  "うーん、まだうまく言葉が出てこないや。ちょっとだけ待ってね。",
  "ごめんね、いまちょっと調子が悪いみたい。落ち着いたらまた話すね。",
];

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
  /** A think still not over this long after the first filler earns a second, different one (ms). Default 2200; 0 disables. */
  fillerRepeatMs?: number;
  /**
   * Said when the model fails before it has said anything. Without it the room hears the filler and
   * then nothing — 「Yuiからの応答がありません」 — and cannot tell a broken model from a character who
   * chose not to answer. One line per consecutive failure, the last repeated: a quota hold lasts a
   * minute, and thirteen identical apologies in that minute (soak 20) is a recording, not a person.
   * Empty disables it.
   */
  recoveryLines?: string[];
  /** Acoustic turn-end model. Absent ⇒ endpointing is silence + text only. */
  turn?: { readonly ready: boolean; predict(samples: Float32Array): Promise<{ probability: number; complete: boolean } | null> };
  /** The user resumed within this many ms of an endpoint ⇒ the endpoint was premature. Default 1200. */
  prematureWindowMs?: number;
  /**
   * Write each committed utterance's audio (preroll included) as a wav here, named by clock and text.
   * Diagnostics for what the recogniser was actually given: Gate #8 run 46 committed 「今日の予定を教えて。」
   * for a line that began 「ゆい、」, and the clean cue decodes with the name — the audio that arrived did not.
   */
  dumpUtterancesDir?: string;
  /**
   * Second-pass recogniser for the committed utterance. The streaming recogniser has to answer while the
   * user is still talking, so it trades accuracy for latency — on Japanese it mangles exactly the words a
   * character is listening for (「ゆいさん」→「ういさん」). Re-decoding the finished utterance with a
   * stronger model costs a few hundred ms once per turn and fixes the text the LLM actually reads.
   */
  finalStt?: STTAdapter | null;
  /**
   * Run `finalStt` beside the turn instead of before it: the transcript goes out on the streaming text
   * at once, and when the second pass reads it differently a `user_transcript_revised` follows. The
   * page's turn decision keeps its speed; the context of the turns after it gets the better words.
   * Only on the client-decides path (`autoRespond` off) — a turn answered here has already read the text.
   */
  finalAsync?: boolean;
  /** How long the deferred pass waits for the page to take a turn on the utterance before running (default 600 ms). */
  finalAsyncGraceMs?: number;
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
  /** Turns in a row on which the model said nothing; picks the recovery line, reset by any answer. */
  private failedTurns = 0;
  /** Work parked until the current reply has finished synthesising (the memory fold), and the speak loop's re-check. */
  private onSynthIdle: (() => void) | null = null;
  private synthCheck: (() => void) | null = null;
  private memory = new ConversationMemory({ recentChars: 2400 });
  private systemPrompt = "";
  private language = "ja-JP";
  private strictLocal = false;
  private abort: AbortController | null = null;
  /** Where the current reply is, for work that must stay off its critical path (the deferred second pass). */
  private replyPhase: "idle" | "before-audio" | "after-audio" = "idle";
  private phaseWaiters: (() => void)[] = [];
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
  /**
   * How long speech has to persist before it counts as a barge-in while the character is speaking
   * or thinking (0 = the onset itself interrupts, the right answer for one person and a headset).
   * In a meeting the VAD fires on every cough, backchannel and open mic in the room, and cutting the
   * character's sentence for each of them is how it never finishes a greeting.
   */
  private bargeInConfirmMs = 0;
  /**
   * `providerOptions.autoRespond === false`: speech is transcribed and endpointed, but never answered on
   * its own — only a `text` turn generates. A meeting page decides which utterances are for the character
   * (participation policy); with drafts on, the agent answered every room fragment, the page cut each one
   * unsanctioned (Gate #8 run 10: 25 drafts, 12 cuts, an LLM call each), and a draft that started speaking
   * before the page's text arrived was cancelled by that very text, taking the sanctioned turn with it.
   */
  private autoRespond = true;
  /** Speech onset that has not yet lasted `bargeInConfirmMs`: the character keeps talking for now. */
  private tentative: { seq: number; voicedMs: number; timer: ReturnType<typeof setTimeout> | null } | null = null;

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
   * anything, which is why the rules around them are strict: at most two per turn and the second only
   * when the first has long gone quiet (fillerRepeatMs), never when the persona has backchannels off,
   * and never once the real first phrase has arrived.
   */
  private filler = {
    clips: [] as { sampleRate: number; pcm16: Int16Array }[],
    next: 0,
    lastGen: -1,
    repeatedGen: -1,
    enabled: false,
    get armed(): boolean {
      return this.enabled && this.clips.length > 0;
    },
    play: (_genId: number, _again = false) => {},
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
    this.filler.play = (genId: number, again = false) => {
      if (!this.filler.clips.length) return;
      // The first one once per turn; the second only after a first, and once.
      if (again ? this.filler.lastGen !== genId || this.filler.repeatedGen === genId : this.filler.lastGen === genId) return;
      if (again) this.filler.repeatedGen = genId;
      else this.filler.lastGen = genId;
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
    const confirm = (config.providerOptions as { bargeInConfirmMs?: unknown } | undefined)?.bargeInConfirmMs;
    this.bargeInConfirmMs = typeof confirm === "number" && Number.isFinite(confirm) && confirm > 0 ? confirm : 0;
    this.autoRespond = (config.providerOptions as { autoRespond?: unknown } | undefined)?.autoRespond !== false;
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
    this.warmPrompt();
  }

  /**
   * The first turn of a session pays for the whole system prompt; on the local model that was 5 s
   * before the first word of a greeting (sim 24), against 250 ms for every turn after. Asking the
   * model to read the prompt now, while nobody is waiting, makes the first turn cost what the rest
   * do. Best effort: a model with no cache ignores it, a failure is only logged.
   */
  private warmPrompt(): void {
    if (!this.deps.llm.warm) return;
    const t = this.clock();
    this.deps.llm
      .warm(this.memory.compose(this.systemPrompt, this.history))
      .then(() => this.deps.log?.(`llm warm ${this.clock() - t}ms`))
      .catch((err: Error) => this.deps.log?.(`llm warm failed: ${err.message}`));
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
        if (this.state === "speaking" || this.state === "thinking") {
          if (this.bargeInConfirmMs > 0) {
            this.holdBargeIn(0);
            continue;
          }
          this.bargeIn(at);
        }
        this.state = "listening";
        this.deps.send({ type: "user_speech_started" });
      } else {
        if (this.tentative) {
          // Short enough to have ended before the confirmation window: not an interruption.
          const voicedMs = Math.round((ev.samples.length / 16000) * 1000);
          if (voicedMs >= this.bargeInConfirmMs) this.confirmBargeIn(at);
          else if (this.state === "speaking" || this.state === "thinking") {
            this.dropTentative(voicedMs);
            continue;
          } else this.confirmBargeIn(at); // the character finished on its own meanwhile: a normal turn
        }
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
        const busy = this.state === "speaking" || this.state === "thinking";
        // Below the confirmation window the onset is provisional: the recogniser hears it, the
        // character does not stop yet. `confirmBargeIn` turns it into a real interruption later.
        const hold = busy && this.bargeInConfirmMs > 0;
        if (busy && !hold) this.bargeIn(at);
        if (this.utterance) {
          // Pause ended: the user is still talking — cancel the pending endpoint.
          if (this.utterance.timer) clearTimeout(this.utterance.timer);
          this.utterance.timer = null;
          stt.onSpeechStart?.();
          if (hold) this.holdBargeIn(this.utterance.seq);
        } else {
          this.utterance = { seq: ++this.utteranceSeq, startedAt: at, segments: [], segmentEndAt: at, timer: null, prefix: this.pendingPrefix, audio: this.pendingAudio };
          this.pendingPrefix = "";
          this.pendingAudio = [];
          stt.start(this.language);
          this.flushPreroll(stt);
          if (hold) {
            this.holdBargeIn(this.utterance.seq);
          } else {
            this.state = "listening";
            this.deps.send({ type: "user_speech_started" });
          }
        }
      } else if (this.utterance) {
        const u = this.utterance;
        u.segments.push(ev.samples);
        const lagMs = ev.endLagSamples !== undefined ? Math.round((ev.endLagSamples / 16000) * 1000) : 0;
        u.segmentEndAt = at - lagMs;
        u.vadEndLagMs = lagMs;
        stt.onSpeechEnd?.();
        const t = this.tentative;
        if (t && t.seq === u.seq) {
          if (t.timer) clearTimeout(t.timer);
          t.timer = null;
          t.voicedMs += Math.round((ev.samples.length / 16000) * 1000);
          if (t.voicedMs >= this.bargeInConfirmMs) this.confirmBargeIn(u.segmentEndAt);
        }
        void this.evaluateEndpoint(u);
      }
    }
  }

  // ---- barge-in confirmation ---------------------------------------------------

  /** The user started talking over the character. Cancel the reply (and, in the streaming path, merge a premature endpoint). */
  private bargeIn(at: number): void {
    this.sessionStats.bargeIns++;
    const le = this.lastEndpoint;
    if (this.policy && le && at - le.at < (this.deps.prematureWindowMs ?? 1200)) {
      // We ended the turn too early: adapt, and merge the text into the next turn.
      this.sessionStats.prematureEndpoints++;
      this.policy.notePrematureEndpoint();
      // Carry the audio too: the second pass must see the whole sentence, not the half that
      // survived the split. 「ありがとう。ゆいさんは…」 paused before the name, and decoding only
      // the tail is how 「ゆい」 kept coming back as 「イ」.
      if (this.utterance) {
        this.utterance.prefix = le.text;
        this.utterance.audio.unshift(...le.audio);
      } else {
        this.pendingPrefix = le.text;
        this.pendingAudio = le.audio;
      }
      if (this.history[le.userHistoryIndex]?.role === "user") this.history.splice(le.userHistoryIndex, 1);
      this.deps.log?.(`premature endpoint (${at - le.at}ms) → merging "${le.text.slice(0, 20)}…"`);
    }
    this.interrupt("barge-in");
  }

  /** Speech onset while busy: start (or resume) the confirmation clock instead of interrupting. */
  private holdBargeIn(seq: number): void {
    const t = this.tentative?.seq === seq ? this.tentative : { seq, voicedMs: 0, timer: null };
    if (t.timer) clearTimeout(t.timer);
    this.tentative = t;
    const remaining = Math.max(20, this.bargeInConfirmMs - t.voicedMs);
    t.timer = setTimeout(() => {
      t.timer = null;
      if (this.tentative === t) this.confirmBargeIn(this.clock());
    }, remaining);
  }

  /** The speech lasted: it is an interruption after all (or a plain turn, if the character finished meanwhile). */
  private confirmBargeIn(at: number): void {
    const t = this.tentative;
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    this.tentative = null;
    if (this.state === "speaking" || this.state === "thinking") {
      this.deps.log?.(`barge-in confirmed after ${t.voicedMs || this.bargeInConfirmMs}ms of speech`);
      this.bargeIn(at);
    }
    this.state = "listening";
    this.deps.send({ type: "user_speech_started" });
  }

  /** Speech that ended before the window: a backchannel, a cough, someone else in the room. */
  private dropTentative(voicedMs: number): void {
    const t = this.tentative;
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    this.tentative = null;
    this.deps.log?.(`ignored ${voicedMs}ms of speech while ${this.state} (< ${this.bargeInConfirmMs}ms barge-in window)`);
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
    // "speaking" is the VAD re-detecting voice before its speech_end has been delivered: there is
    // nothing to decide until it ends. Polled — the detection can also drop without a segment — but
    // not at `waitMs: 0`, which spun this loop ~170 times over 300 ms (Gate #8 run 46).
    const wait = d.reason === "speaking" ? Math.max(d.waitMs, 60) : d.waitMs;
    u.timer = setTimeout(() => {
      u.timer = null;
      if (this.utterance !== u) return;
      const silence = this.clock() - u.segmentEndAt;
      const again = policy.evaluate({ speaking: this.deps.vad.speaking, silenceMs: silence, text, stable: true, acoustic });
      if (again.decision === "endpoint") void this.commitTurn(u, text, { reason: again.reason, requiredSilenceMs: again.requiredSilenceMs, sttMs: 0, reused: true });
      else void this.evaluateEndpoint(u); // still waiting: re-evaluate later (max_silence is the hard cap)
    }, wait);
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
      const rejected = text !== streamed ? rescoreRejection(streamed, text, total / 16000) : undefined;
      if (rejected) { this.deps.log?.(`rescore ${ms}ms "${streamed}" → "${text}" dropped (${rejected}) — keeping the streaming text`); return streamed; }
      if (text !== streamed) this.deps.log?.(`rescore ${ms}ms "${streamed}" → "${text}"`);
      return text;
    } catch (err) {
      this.deps.log?.(`rescore failed (${(err as Error).message}) — keeping the streaming text`);
      return streamed;
    }
  }

  /** The deferred second pass: a revision goes out only when it read something different. */
  private reviseLater(u: Utterance, streamed: string): void {
    void this.offReplyPath().then(() => this.rescore(u, streamed)).then((text) => {
      if (text !== streamed && text.trim()) this.deps.send({ type: "user_transcript_revised", id: u.seq, text });
    });
  }

  /**
   * The second recogniser shares the machine with the model. Run at the same moment as the reply it
   * cost the first sound 0.4–0.8 s (sim 40: 1364 / 1649 / 1257 ms against 723–1001 ms without it), so
   * the pass waits until the reply has its first audio out. If the page takes no turn on the
   * utterance within the grace, there is nothing to stay out of the way of. Capped: a reply that
   * never reaches audio must not hold the revision forever.
   */
  private async offReplyPath(): Promise<void> {
    await this.waitReplyPhase((p) => p !== "idle", this.deps.finalAsyncGraceMs ?? 600);
    await this.waitReplyPhase((p) => p !== "before-audio", 4000);
  }

  private waitReplyPhase(done: (p: ConversationSession["replyPhase"]) => boolean, ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (done(this.replyPhase)) return resolve();
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, ms);
      const waiter = () => { if (settled) return; if (done(this.replyPhase)) finish(); else this.phaseWaiters.push(waiter); };
      this.phaseWaiters.push(waiter);
    });
  }

  private setReplyPhase(p: ConversationSession["replyPhase"]): void {
    if (this.replyPhase === p) return;
    this.replyPhase = p;
    const waiters = this.phaseWaiters;
    this.phaseWaiters = [];
    for (const w of waiters) w();
  }

  /** Diagnostics only (see `dumpUtterancesDir`): never on the turn's path, never fatal. */
  private dumpUtterance(u: Utterance, text: string): void {
    try {
      const total = u.audio.reduce((n, a) => n + a.length, 0);
      const pcm = new Int16Array(total);
      let o = 0;
      for (const a of u.audio) for (const v of a) pcm[o++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      const dir = this.deps.dumpUtterancesDir!;
      mkdirSync(dir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}_${text.replace(/[\s\u3000\/\\:*?"<>|]/g, "").slice(0, 24) || "empty"}.wav`;
      writeFileSync(join(dir, name), encodeWav(pcm, 16000));
      this.deps.log?.(`dumped utterance ${Math.round((total / 16000) * 1000)}ms → ${name}`);
    } catch (err) {
      this.deps.log?.(`utterance dump failed: ${(err as Error).message}`);
    }
  }

  /** The whole text turn, next to the utterance wavs: the log keeps 60 characters, a prompt is 500. */
  private dumpText(text: string): void {
    try {
      const dir = this.deps.dumpUtterancesDir!;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_turn.txt`), text);
    } catch (err) {
      this.deps.log?.(`turn dump failed: ${(err as Error).message}`);
    }
  }

  private async commitTurn(u: Utterance, text: string, ep: { reason: string; requiredSilenceMs: number; sttMs: number; reused: boolean }): Promise<void> {
    if (this.utterance !== u) return;
    const stt = this.streamingStt!;
    if (this.tentative?.seq === u.seq) {
      if (this.state === "speaking" || this.state === "thinking") {
        // Ended before it could count as a barge-in, and the character is still talking: not a turn.
        this.dropTentative(this.tentative.voicedMs);
        this.utterance = null;
        await stt.endUtterance();
        return;
      }
      this.confirmBargeIn(u.segmentEndAt); // the character finished on its own: an ordinary turn
    }
    this.utterance = null;
    const final = await stt.endUtterance({ trailingSilenceMs: this.clock() - u.segmentEndAt });
    if (this.utterance !== null) return; // new speech arrived while finalising
    const at = this.clock();
    this.deps.send({ type: "user_speech_ended" });
    this.state = "thinking";
    this.policy!.noteCleanEndpoint(); // provisional; a barge-in within the premature window revises it
    const streamed = final.text || text.replace(u.prefix, "").trim();
    const deferred = Boolean(this.deps.finalAsync) && !this.autoRespond;
    const rescored = deferred ? streamed : await this.rescore(u, streamed);
    // `rescore` decodes the whole utterance audio, prefix included, so it already covers the merged text.
    const merged = rescored !== streamed ? rescored : (u.prefix ? `${u.prefix} ` : "") + streamed;
    if (this.deps.dumpUtterancesDir) this.dumpUtterance(u, merged);
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
    this.deps.send({ type: "user_transcript", text: merged, final: true, id: u.seq });
    if (deferred) this.reviseLater(u, streamed);
    if (!this.autoRespond) {
      this.state = "idle";
      return;
    }
    this.lastEndpoint = { at, text: merged, userHistoryIndex: this.history.length, audio: u.audio };
    await this.respond(merged, turn);
  }

  async onText(text: string): Promise<void> {
    // Logged on receipt: a text turn that never becomes a generation is otherwise invisible here.
    this.deps.log?.(`text${this.started ? "" : " (ignored: not started)"} "${text.replace(/\s+/g, " ").slice(0, 60)}"`);
    if (!this.started) return;
    if (this.deps.dumpUtterancesDir) this.dumpText(text);
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
    this.onSynthIdle = null; // a fold parked behind a reply that was cut off waits for the next turn
    return this.activeGeneration;
  }

  private stamp(): WireGen {
    return { turnId: this.gen.turnId, generationId: this.gen.generationId, sequence: this.gen.sequence++ };
  }

  /** Send an assistant-side message iff `genId` is still the active generation. */
  private sendGen(genId: number, msg: Exclude<ServerMessage, { type: "ready" | "user_speech_started" | "user_speech_ended" | "user_transcript" | "user_transcript_revised" | "error" | "interrupted" }>): boolean {
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
    const changed = ctx.systemPrompt !== this.systemPrompt;
    this.systemPrompt = ctx.systemPrompt;
    if (ctx.history) {
      this.history = ctx.history.map((h) => ({ role: h.role, content: h.text }));
      this.memory.reset();
    }
    if (changed && this.started) this.warmPrompt();
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
    if (this.tentative?.timer) clearTimeout(this.tentative.timer);
    this.tentative = null;
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
    if (!this.autoRespond) {
      this.state = "idle";
      return;
    }
    await this.respond(text, turn);
  }

  private async respond(userText: string, turn: TurnClock): Promise<void> {
    this.setReplyPhase("before-audio");
    try {
      await this.generate(userText, turn);
    } finally {
      this.setReplyPhase("idle");
    }
  }

  private async generate(userText: string, turn: TurnClock): Promise<void> {
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
     * Only when the wait is actually long, and only if the persona allows backchannels: a character
     * that says 「えーっと」 before every sentence has a verbal tic, which is worse than a pause.
     *
     * One filler does not cover a stalled model. When the first token took 3.8 s (Gate #8 run 47, a
     * hedged request), the room heard 「えーっと、」 and then 4.0 s of nothing before the answer — a
     * hole, not a beat. A person whose thought is taking that long says something again — 「そうですね、」
     * — so a second, different filler goes out when the think is still not over `fillerRepeatMs`
     * after the first. Never a third: past that point the silence is the honest signal.
     */
    const fillerAfterMs = this.deps.fillerAfterMs ?? 400;
    const fillerRepeatMs = this.deps.fillerRepeatMs ?? 2200;
    const fillerTimers: ReturnType<typeof setTimeout>[] = [];
    if (this.filler.enabled) {
      fillerTimers.push(setTimeout(() => {
        // Checked here, not when the timer was set: pre-rendering takes a moment on a real engine,
        // and the first turn of a session is exactly when a long think is most likely.
        if (!abort.signal.aborted && !turn.firstPhraseAt && this.filler.armed) this.filler.play(genId);
      }, fillerAfterMs));
      if (fillerRepeatMs > 0) {
        fillerTimers.push(setTimeout(() => {
          if (!abort.signal.aborted && !turn.firstPhraseAt && !turn.firstTokenAt && this.filler.armed) this.filler.play(genId, true);
        }, fillerAfterMs + fillerRepeatMs));
      }
    }
    const clearFillers = () => { for (const t of fillerTimers) clearTimeout(t); };
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
      clearFillers();
      if (full.trim()) this.failedTurns = 0;
      this.deps.log?.(`llm first-token ${(turn.firstTokenAt ?? 0) - turn.llmStartAt}ms first-phrase ${(turn.firstPhraseAt ?? 0) - turn.llmStartAt}ms total ${this.clock() - turn.llmStartAt}ms`);
    } catch (err) {
      // Logged as well as sent: a failing model otherwise reads as `reply "" (no audio)` in the agent's
      // own log, which is indistinguishable from a model that had nothing to say.
      if (!abort.signal.aborted) {
        this.deps.log?.(`llm error: ${(err as Error).message}`);
        this.deps.send({ type: "error", message: `llm: ${(err as Error).message}` });
        // A filler and then silence is the one thing worse than a slow answer: own the miss out loud.
        if (!full.trim()) {
          const lines = this.deps.recoveryLines ?? RECOVERY_LINES;
          const recovery = lines[Math.min(this.failedTurns++, lines.length - 1)];
          if (recovery) {
            full = recovery;
            pushChunk(recovery);
          }
        }
      }
    } finally {
      clearFillers();
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
      // A fold rewrites the notes inside the system message, so the next turn's prompt differs from
      // the cached one from the notes on and llama.cpp re-reads everything after them (first token
      // 1.9–2.4 s against 0.35–0.45 s, run 89, every turn after a "memory folded"). Reading the new
      // prompt back now, while the voice is still speaking, puts that cost where nobody waits.
      // Skipped when a newer turn owns the model — its own reply caches the prompt.
      //
      // Started once the reply has finished synthesising, not when the model finished writing it:
      // the fold's 6 s request ran alongside Supertonic and each phrase took 1.4 s instead of 0.3 s
      // (run 90, pass 3). Synthesis is over seconds before the voice is — pass 3 would have folded
      // and re-read from 33.4 s to 40.8 s with the voice speaking until 43.2 s. A reply that was cut
      // off does not fold at all (a barge-in turn is about to use the model); the next turn folds.
      if (!abort.signal.aborted) {
        const fold = () => void this.memory.fold(this.deps.llm, this.deps.log).then((folded) => {
          if (folded && this.started && genId === this.activeGeneration) this.warmPrompt();
        });
        if (this.synthCheck) {
          this.onSynthIdle = fold;
          this.synthCheck();
        } else {
          fold();
        }
      }
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
    // Phrases requested from the voice whose first audio has not come back yet. Once the model has
    // finished (queue closed), the queue is drained and nothing is in flight, every phrase of the
    // reply is synthesised and parked work (the memory fold) may take the CPU.
    let inFlight = 0;
    const check = (): void => {
      if (!queue.isClosed || queue.size > 0 || inFlight > 0 || signal.aborted) return;
      const cb = this.onSynthIdle;
      this.onSynthIdle = null;
      cb?.();
    };
    this.synthCheck = check;
    try {
      return await this.speakPhrases(queue, signal, turn, genId, { onRequested: () => { inFlight++; }, onSynthesized: () => { inFlight--; check(); } });
    } finally {
      if (this.synthCheck === check) this.synthCheck = null;
    }
  }

  private async speakPhrases(queue: AsyncQueue<string>, signal: AbortSignal, turn: TurnClock, genId: number, synth: { onRequested: () => void; onSynthesized: () => void }): Promise<boolean> {
    let spoke = false;
    let startedAt = 0;
    let sentMs = 0;
    const chunkMs = this.deps.chunkMs ?? 40;
    const leadMs = this.deps.leadMs ?? 600;

    const take = async (): Promise<{ phrase: string; stream: AsyncIterable<TTSResult>; requestedAt: number } | null> => {
      const s = await queue.next();
      if (s === null) return null;
      synth.onRequested();
      try {
        return { phrase: s, stream: this.ttsStream(s, signal), requestedAt: this.clock() };
      } catch (err) {
        if (!signal.aborted) this.deps.send({ type: "error", message: `tts: ${(err as Error).message}` });
        synth.onSynthesized();
        return { phrase: s, stream: { async *[Symbol.asyncIterator]() {} }, requestedAt: this.clock() };
      }
    };

    const sendPcm = async (sampleRate: number, pcm16: Int16Array): Promise<void> => {
      const lead = sentMs - (this.clock() - startedAt);
      if (lead > leadMs) await sleep(lead - leadMs, signal);
      if (signal.aborted) return;
      if (!this.sendAudioGen(genId, sampleRate, pcm16)) return; // cancelled generation: late chunk dropped
      const now = this.clock();
      if (!turn.firstAudioSentAt) {
        turn.firstAudioSentAt = now;
        if (this.replyPhase === "before-audio") this.setReplyPhase("after-audio");
      }
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
      let firstAt = 0;
      let synthesized = false;
      const synthesizedNow = (): void => { if (!synthesized) { synthesized = true; synth.onSynthesized(); } };
      try {
        for await (const chunk of pending.stream) {
          if (signal.aborted) return spoke;
          synthesizedNow();
          if (chunk.pcm16.length === 0) continue;
          if (!spoke) {
            spoke = true;
            this.state = "speaking";
            if (!this.sendGen(genId, { type: "assistant_speech_started" })) return spoke;
            startedAt = this.clock();
          }
          if (!turn.firstTtsAudioAt) turn.firstTtsAudioAt = this.clock();
          if (!firstAt) firstAt = this.clock();
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
        // Two numbers: the wait for the phrase's first audio, and how long its paced frames took to go out.
        this.deps.log?.(`tts ${firstAt ? firstAt - t0 : 0}ms to first audio, ${this.clock() - t0}ms to last frame "${pending.phrase.slice(0, 20)}"`);
      } catch (err) {
        if (!signal.aborted) this.deps.send({ type: "error", message: `tts: ${(err as Error).message}` });
      }
      synthesizedNow();
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
