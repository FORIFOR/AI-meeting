import { EnergyVAD, MicCapture, SpeakerOutput, dbfs, rms, type PCMFrame } from "@rcai/audio-core";
import { ConversationRuntime, type ConversationEvent, type ProviderId } from "@rcai/conversation-core";
import { AvatarRuntime, loadCharacter, type AvatarProvider, type CharacterDefinition, type Emotion, type StateTransition } from "@rcai/avatar-core";
import { BehaviorEngine, RemoteSemanticPlanner } from "@rcai/behavior-engine";
import { createSessionConfig, type Persona } from "@rcai/persona-core";
import { JOINED_REASON, LIVE_LOOKUP_TOOL, ParticipationPolicy, SELF_TURN_REASON, parseLookupArguments, renderLookup, settingFor, type LiveLookupResult, canonicalizeName, meetingGreetingPrompt, meetingInstructions, meetingTurnPrompt, type MeetingEvent, type MeetingSession, type MeetingStatus, type PolicyTransition, type Proactivity } from "@rcai/meeting-core";
import type { VisualCue } from "@rcai/visual-core";
import { VisualPerceptionService } from "./VisualPerceptionService.js";
import { OnDemandConversation } from "./OnDemandConversation.js";
import { MeetingMemory } from "./MeetingMemory.js";
import { createAvatarProvider, createConversationProvider, createMeetingConnector, plannerUrl, type CharacterEntry } from "../integrations/registry.js";
import { chosenVoice, decide, type Availability, type Settings } from "../state/settings.js";

/** Gemini Live takes at most 1 fps, and every frame costs tokens whether or not it changes anything. */
const VISION_MIN_INTERVAL_MS = 5000;

/** How long the pipeline waits for the AudioContext before mounting the avatar anyway. */
const AUDIO_START_GRACE_MS = 2500;

export interface MeetingTranscriptLine {
  id: number;
  speaker: string;
  text: string;
  final: boolean;
  at: number;
  self?: boolean;
}

export interface MeetingHandlers {
  onUsage?(counters: Record<string, number>): void;
  onStatus(status: MeetingStatus, detail?: string): void;
  onTranscript(line: MeetingTranscriptLine): void;
  onPolicy(t: PolicyTransition): void;
  onAvatarState?(t: StateTransition): void;
  onEvent?(e: ConversationEvent): void;
  /** Host muted / unmuted the character (outbound speech is held while muted). */
  onMuted?(muted: boolean): void;
  /** Bot page: the signed token was accepted by the broker (single activation). */
  onActivated?(a: { sessionId: string; botId: string }): void;
  onError(message: string, code?: string): void;
}

export interface MeetingInit {
  observer?: "captions" | "live";
  settings: Settings;
  availability: Availability;
  persona: Persona;
  character: CharacterEntry;
  meetingUrl: string;
  displayName: string;
  proactivity: Proactivity;
  /**
   * operator: this browser created the bot and monitors it (output_media: the bot runs our page; relay: this
   *           browser also runs the whole conversation and pushes audio back as clips).
   * bot:      this page IS running inside the Recall bot (Output Media) — meeting audio in via getUserMedia,
   *           speaker out = meeting, avatar = bot camera.
   */
  role: "operator" | "bot";
  /** bot role: signed single-use session token from the page URL (Round 3 Gate 5). */
  botToken?: string;
  /** bot role: broker public URL peeked from the token (the broker verifies the signature). */
  botBrokerUrl?: string;
  /**
   * Public agent origin for a bot page. Recall blocks loopback inside the Output Media process, so the
   * operator's `ws://localhost:8788` is unreachable there and the character would never speak.
   */
  botAgentUrl?: string;
  /**
   * Show the conversational model the camera, not just the face measurements. Off by default: it costs
   * tokens on every frame and sends a participant's image to a cloud provider, which is a decision
   * rather than a detail.
   */
  vision?: boolean;
  /** Read the webcam at all. Off means no face model is loaded and no frames are decoded. */
  visualCues?: boolean;
  /**
   * How the character's voice leaves this page on a vendor that runs it as a voice agent.
   * "socket" (default) sends it back over the relay, where it can be counted; "page" relies on the
   * vendor capturing the page's speaker, which is invisible from here.
   */
  outboundPath?: "socket" | "page";
  /**
   * How the character is framed on the stage. A bot page is a camera tile and defaults to "meeting"
   * (head and shoulders, flat background); "default" keeps the operator's full portrait — the A/B
   * switch for measuring the tile the room actually sees.
   */
  framing?: "default" | "meeting";
  /** Cap on the avatar's render frame rate; the bot page takes it from its `fps` query (a vendor's page browser is often short of CPU). */
  avatarFps?: number;
  /** Meeting vendor: "recall" (default) or "attendee". */
  meetingProvider?: "recall" | "attendee";
  /** Attendee voice-agent page: attach to the bot already carrying us instead of creating another. */
  attendeeAttach?: { botId: string; clientWsUrl: string };
  /**
   * Voice chosen by the operator. The bot page has its own empty settings storage, so the choice
   * only survives the trip when it is carried explicitly (bot role) rather than read from settings.
   */
  voiceId?: string;
  /** bot role: activation already performed by the screen (tokens are single-use — never activate twice). */
  botActivation?: { sessionId: string; botId: string; clientToken?: string };
  connectorMode?: "output_media" | "relay";
  stage: HTMLElement | null;
  handlers: MeetingHandlers;
  /** bot role only: transcript feed from the bot's own data websocket (injected for tests). */
  botTranscriptFeed?: (cb: (e: { text: string; final: boolean; speakerName: string | null; participantId?: string }) => void) => () => void;
}

/**
 * Meeting participation (P0-1). Contract boundaries: MeetingConnector (vendor) ↔ ParticipationPolicy (pure) ↔
 * ConversationRuntime (AI) ↔ AvatarRuntime. The AI only hears the meeting while the policy allows it and is
 * handed the addressing utterance as text (provider-agnostic), so it answers what it was asked.
 */
/** How long room speech must last before the bot treats it as a barge-in (provider option, local agent). */
const BOT_BARGE_IN_CONFIRM_MS = 600;
/** How much of each participant's loudness is kept for attributing an utterance (see `attribute`). */
const LEVEL_LEDGER_MS = 20_000;
/** The loudest stream over an utterance must carry this many times the runner-up's energy to be its speaker. */
const ATTRIBUTION_MARGIN = 3;
/** How often the character is told the time again, so a long meeting's dates stay true. */
const CLOCK_REFRESH_MS = 10 * 60_000;

/**
 * How long a sanctioned turn may go without the character starting to speak before the page gives
 * it up. A local agent needs ~3 s for its first token and up to ~7 s for its first phrase of audio;
 * far past that, the answer is not coming — the text never reached the agent, or the model hung —
 * and a turn held open blocks every address that follows (Gate #8 run 9: the greeting's turn stayed
 * ADDRESSED for 27 s and 「ゆい、今日の予定を教えて」 found the floor already taken).
 */
const ANSWER_STALL_MS = 20_000;
/**
 * Backoff between attempts to get the AI back after its socket closes under a live meeting. Gate #8
 * run 81 pass 2: the agent's WebSocket closed 40 s into the pass with nothing logged on either side;
 * the ears kept delivering the room, the policy kept hearing nothing, and the character sat silent
 * through four questions. A bot in a room has nothing better to do than keep trying.
 */
const AGENT_RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];

/** A line the character heard recently: what a turn reads as context, and whose words it was. */
interface RecentLine { speaker: string; text: string; utterance?: number; participantId?: string; line: MeetingTranscriptLine }

export class MeetingSessionController {
  readonly policy: ParticipationPolicy;
  private session: MeetingSession | null = null;
  private runtime: ConversationRuntime | null = null;
  private speaker: SpeakerOutput | null = null;
  private mic: MicCapture | null = null;
  private avatar: AvatarProvider | null = null;
  private avatarRuntime: AvatarRuntime | null = null;
  private behavior: BehaviorEngine | null = null;
  private character: CharacterDefinition | null = null;
  private stopFeed: (() => void) | null = null;
  private vad = new EnergyVAD();
  /** `utterance` = the AI recogniser's utterance id, when the line came from it: what a revision addresses. */
  private recent: RecentLine[] = [];
  /** The recogniser utterance being handed to the policy right now (so a turn can be tied to its line). */
  private feeding: number | undefined;
  /** The utterance the current sanctioned turn was taken on, and why — for the rescore's second opinion. */
  private turnOf: { utterance: number | undefined; reason: string } | null = null;
  private lineId = 0;
  /** Why the character cannot be seen, when it cannot be — reported once, and readable afterwards. */
  avatarFailure: string | null = null;
  private visual: VisualPerceptionService | null = null;
  /** The latest cue per participant, for the answer's context. Observations, never conclusions. */
  private cues = new Map<string, VisualCue>();
  private lastVisionAt = -Infinity;
  /** Who spoke most recently, from the per-participant audio stream — the AI's transcripts carry no name. */
  private heardAnything = false;
  private sawTranscript = false;
  private heard = 0;
  /**
   * The ears as a recording would show them: seconds actually delivered, frames that were digital
   * silence, and arrival holes. Gate #8 run 70 lost two thirds of a question between the room and the
   * recogniser, and `heard` alone (a chunk count) could not say where; the heartbeat carries these.
   */
  private heardMs = 0;
  private zeroFrames = 0;
  private gaps = 0;
  private lastHeardAt = 0;
  private forwarded = 0;
  private transcripts = 0;
  /** Answers the provider began, and turns the page refused — the two ends of "why is she silent". */
  private answers = 0;
  private cuts = 0;
  /** The conversation provider, kept for its own diagnostics (the Gemini gate's counters). */
  private provider: { gateStats?: Record<string, number>; usageSnapshot?(): Record<string, number> } | null = null;
  /** Whether this session declared the live lookup, which is also what the instructions were told. */
  private canLookUp = false;
  /** Rebuilds the session instructions for a given wall clock; used to keep the date true. */
  private instructions: ((now: string) => string) | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  /** Live lookups made and how many came back with something, for the heartbeat. */
  private lookups = { asked: 0, answered: 0 };
  private spokeFrames = 0;
  /** The current sanctioned reply, as the provider transcribed it and as seconds of audio actually sent. */
  private spokeText = "";
  private spokeSeconds = 0;
  /**
   * Did the policy decide to take this turn?
   *
   * A provider like Gemini Live hears the room continuously and answers whenever it feels addressed —
   * it knows nothing about a participation policy. Gating on "the character is currently speaking"
   * therefore lets it into any conversation it overhears: measured, it spoke while the policy sat in
   * PASSIVE. The gate is the decision, not the symptom of one.
   */
  private sanctioned = false;
  /** The live provider is already generating a reply to this input transcript. */
  private providerTranscriptTurn = false;
  /** The arrival greeting has been scheduled (once per page, never per reconnect). */
  private greeted = false;
  /** The pipeline accepts text turns; an on-demand provider may still be observing without a socket. */
  private runtimeReady = false;
  private readonly meetingMemory = new MeetingMemory();
  private usageTotals: Record<string, number> = {};
  private usageBase: Record<string, number> = {};
  private usageReportedAt = 0;
  /** How the AI provider was made, kept so it can be made again when its session closes under us. */
  private providerOpts: Parameters<typeof createConversationProvider>[1] | null = null;
  /** A reconnect to the AI is in progress (its own `session_closed` must not start another). */
  private reconnecting = false;
  /** Pending ANSWER_STALL_MS watchdog for the sanctioned turn, if any. */
  /** Every spelling of the character's name the transcript may carry (see `canonicalizeName`). */
  private readonly names: string[];
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  /** Room speech that began while a sanctioned answer was still being thought up; a barge-in only if it lasts. */
  private thinkingBargeTimer: ReturnType<typeof setTimeout> | null = null;
  private cueCount = 0;
  private faceCount = 0;
  private shownToModel = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastSpeaker: string | null = null;
  private lastSpeakerId: string | undefined;
  /** Each participant's recent loudness on their own stream (linear power, page time), see `attribute`. */
  private readonly levels = new Map<string, { at: number; power: number }[]>();
  /** The room speech the recogniser is working on, bracketed by its own VAD, in page time. */
  private utterance: { from: number; to: number | null } | null = null;

  /** Never throws: an avatar that will not load is reported and the meeting continues with the voice. */
  private async createAvatar(character: CharacterEntry, stage: HTMLElement, brokerUrl: string, privacyMode: Settings["privacyMode"]): Promise<AvatarProvider | null> {
    try {
      const framing = this.init.framing ?? (this.init.role === "bot" ? "meeting" : "default");
      return await createAvatarProvider(character.renderer, { container: stage, brokerUrl, privacyMode, framing, ...(this.init.avatarFps ? { maxFps: this.init.avatarFps } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.avatarFailure = message;
      this.init.handlers.onError(message, message.startsWith("BLOCKED_BY_NO_WEBGL") ? "AVATAR_NO_WEBGL" : "AVATAR");
      return null;
    }
  }


  /** Explicit choice (bot page / caller) first, then this browser's setting for the pair. */
  private voiceId(characterId?: string): string | undefined {
    return this.init.voiceId ?? chosenVoice(this.init.settings, characterId ?? this.init.character.id, this.decision.conversation);
  }

  private forwarding = false;
  private policyTimer: ReturnType<typeof setInterval> | null = null;
  private decision: ReturnType<typeof decide>;
  private disposed = false;
  private muted = false;
  private meetingStatus: MeetingStatus | null = null;
  private activated: { sessionId: string; botId: string; clientToken?: string } | null = null;
  /** Animation-frame callbacks since the heartbeat; measures page scheduling, not the avatar ticker or captured video rate. */
  private drawn = 0;
  private drawLoop: number | null = null;
  private lastBeatAt = 0;

  constructor(private readonly init: MeetingInit) {
    this.decision = decide(init.settings, init.availability);
    // Aliases matter in Japanese meetings: STT writes 「ゆい」, never "Yui".
    const names = [init.displayName, init.character.name, ...(init.character.aliases ?? [])].filter(Boolean);
    this.names = names;
    this.policy = new ParticipationPolicy({ names, soundalikes: init.character.soundalikes, proactivity: init.proactivity });
    /**
     * Answering is driven by the transition, not by the transcript that usually causes it. The
     * proactive tiers ("active", "open") enter ADDRESSED from the timer — the room falling quiet is
     * the trigger — and a transcript-only hook left those modes silent forever: the state machine said
     * ADDRESSED and nothing ever asked the AI to speak.
     */
    this.policy.onTransition((t) => {
      init.handlers.onPolicy(t);
      if (t.to === "ADDRESSED") {
        // The policy decided this turn is ours. Nothing else may open the outbound gate.
        this.sanctioned = true;
        this.turnOf = { utterance: this.feeding, reason: t.reason };
        if (this.init.role === "bot") {
          // Who this turn is for is part of the evidence: run 71 answered the host's television as a follow-up.
          const turn = { reason: t.reason, text: this.policy.addressedBy?.text ?? "", participantId: this.policy.engagedWith?.participantId };
          console.log("[rcai:bot] turn", JSON.stringify(turn));
          this.report("turn", turn);
        }
        // A turn the provider took on its own is already being spoken; asking for it again would
        // answer twice.
        if (t.reason !== SELF_TURN_REASON && !this.providerTranscriptTurn) void this.answer();
      }
      /**
       * The character's face follows the conversation, not only the audio. Being spoken to and
       * deciding to answer look different from listening to a room, and a face that only changes when
       * sound starts is a face that arrives late to every turn.
       */
      if (t.to === "ADDRESSED") this.avatarRuntime?.handleEvent({ type: "assistant_thinking" });
      if (t.to === "LISTENING") this.avatarRuntime?.handleEvent({ type: "user_speech_started", at: t.at });
      if (t.to === "OBSERVING" && t.reason === "interrupted") this.avatarRuntime?.handleEvent({ type: "interrupted" });
    });
  }

  /** A meeting's room, or the ordinary one-to-one: what the character is told is around it. */
  private get setting(): "meeting" | "one_to_one" {
    return settingFor({ personaId: this.init.persona.id, mode: this.init.persona.mode });
  }

  private get usesObserver(): boolean {
    return this.init.observer === "captions" || (this.init.observer !== "live" && this.init.role !== "bot" && this.init.meetingProvider === "attendee" && this.setting === "meeting");
  }

  get providerId(): ProviderId {
    return this.decision.conversation;
  }

  get botId(): string | null {
    return this.session?.id ?? null;
  }

  /** Meeting audio reaches the AI only while the policy says so (ADDRESSED / RESPONDING). */
  get isForwarding(): boolean {
    return this.forwarding;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Outbound speech is allowed only while admitted, not muted and not reconnecting. */
  get outboundAllowed(): boolean {
    if (this.muted) return false;
    const st = this.meetingStatus;
    if (this.init.role === "bot") return st === null || st === "in_call" || st === "in_call_not_recording";
    return st === "in_call" || st === "in_call_not_recording";
  }

  async start(): Promise<void> {
    const { role, settings, handlers } = this.init;
    if (settings.privacyMode === "strict_local") throw new Error("BLOCKED_BY_STRICT_LOCAL: meetings need a cloud meeting service");
    if (role === "operator") await this.startOperator();
    else await this.startBotPage();
    this.policyTimer = setInterval(() => this.policy.tick(Date.now()), 250);
    /**
     * A bot page runs unattended inside a vendor's browser. Every failure so far has been "which hop
     * went quiet", and answering it has needed a rebuild each time. One line every five seconds costs
     * nothing and answers it from the logs the vendor already keeps.
     */
    if (role === "bot" && typeof requestAnimationFrame === "function") {
      const tick = (): void => { this.drawn++; this.drawLoop = requestAnimationFrame(tick); };
      this.drawLoop = requestAnimationFrame(tick);
      this.lastBeatAt = performance.now();
    }
    /**
     * The clock in the instructions is right when the session opens and wrong an hour later. A meeting
     * can run longer than that, so it is said again — as context, which providers accept mid-session.
     */
    this.clockTimer = setInterval(() => {
      if (!this.instructions) return;
      void this.runtime?.updateContext({
        systemPrompt: this.instructions(localClock(new Date())),
        mode: this.init.persona.mode,
        language: this.init.persona.language,
      });
    }, CLOCK_REFRESH_MS);
    let previousAudioClockMs = this.speaker ? this.speaker.context.currentTime * 1000 : null;
    let previousAudioClockWallMs = performance.now();
    this.heartbeat = setInterval(() => {
      const t = performance.now();
      const audioClockMs = this.speaker ? this.speaker.context.currentTime * 1000 : null;
      const audioClockLagMs = audioClockMs !== null && previousAudioClockMs !== null
        ? Math.round((t - previousAudioClockWallMs) - (audioClockMs - previousAudioClockMs)) : null;
      previousAudioClockMs = audioClockMs;
      previousAudioClockWallMs = t;
      const fps = this.lastBeatAt ? Math.round((this.drawn * 1000) / Math.max(1, t - this.lastBeatAt)) : null;
      this.drawn = 0;
      this.lastBeatAt = t;
      const beat = {
        heard: this.heard, heardMs: Math.round(this.heardMs), zeroFrames: this.zeroFrames, gaps: this.gaps, forwarded: this.forwarded, transcripts: this.transcripts, spoke: this.spokeFrames,
        cues: this.cueCount, faces: this.faceCount, shown: this.shownToModel, sanctioned: this.sanctioned,
        state: this.policy.state, engagement: this.policy.engagementState, status: this.meetingStatus,
        answers: this.answers, cuts: this.cuts, gate: this.provider?.gateStats, lookups: this.lookups,
        fps, avatar: this.avatarFailure ?? (this.avatar ? "ok" : "none"),
        playback: this.speaker ? { state: this.speaker.context.state, queuedAudioMs: this.speaker.queuedAudioMs, audioClockLagMs } : null,
      };
      console.log("[rcai:bot] " + JSON.stringify(beat));
      this.report("heartbeat", beat);
      const usage = this.provider?.usageSnapshot?.();
      if (usage) this.publishUsage(usage);
    }, 5000);
    handlers.onStatus(this.session?.status() ?? "in_call");
  }

  // ---- operator ---------------------------------------------------------------------------------
  private async startOperator(): Promise<void> {
    const { settings, character, persona, meetingUrl, displayName, handlers, connectorMode } = this.init;
    const mode = connectorMode ?? "output_media";
    /**
     * Which meeting vendor carries this call. The rest of this file does not care — that is what the
     * connector boundary is for — but Attendee streams the character's audio back on the socket it sends
     * on, so it runs the relay path where the conversation lives here rather than inside the bot.
     */
    const provider = (this.init.meetingProvider ?? "recall") as "recall" | "attendee";
    const connector = await createMeetingConnector(provider, {
      brokerUrl: settings.brokerUrl,
      privacyMode: settings.privacyMode,
      mode,
      botPageQuery: {
        character: character.id,
        persona: persona.id,
        engine: this.decision.conversation,
        name: displayName,
        proactivity: this.init.proactivity,
        language: persona.language,
        ...(provider === "attendee" && this.usesObserver ? { observer: "captions" } : {}),
        ...(provider === "attendee" ? { outbound: "page" } : {}),
        vision: this.init.vision ? "model" : this.init.visualCues === false ? "off" : "cues",
        ...(this.voiceId() ? { voice: this.voiceId()! } : {}),
      },
    });
    const session = await connector.join({ meetingUrl, displayName, privacyMode: settings.privacyMode, language: persona.language.split("-")[0] });
    this.session = session;
    session.onEvent((e) => this.onMeetingEvent(e));
    if (mode === "relay") {
      // The whole conversation runs here; meeting audio arrives through the relay.
      await this.startPipeline({ micFromMeeting: true });
    }
    handlers.onStatus(session.status(), "bot created");
  }

  // ---- bot page ---------------------------------------------------------------------------------
  /**
   * Tell the broker what happened, so a harness outside the vendor can read it. The page's console is
   * unreadable from where it runs; this is the only channel that leaves the container. Best effort and
   * never awaited — a report that fails must not touch the conversation.
   */
  private report(type: string, data: Record<string, unknown>): void {
    const a = this.activated;
    if (this.init.role !== "bot" || !a?.clientToken) return;
    const base = (this.init.botBrokerUrl ?? this.init.settings.brokerUrl).replace(/\/$/, "");
    void fetch(`${base}/api/meeting/session/${encodeURIComponent(a.sessionId)}/report`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.clientToken}` },
      body: JSON.stringify({ type, data }),
      keepalive: true,
    }).catch(() => { /* observation only */ });
  }

  private async startBotPage(): Promise<void> {
    // Gate 5: the page must prove it was loaded from a signed, unexpired, unused bot-page URL before doing anything.
    const { botToken, botBrokerUrl, botActivation, settings, handlers } = this.init;
    if (botActivation) this.activated = botActivation;
    else {
      if (!botToken) throw new Error("BOT_PAGE_TOKEN_REQUIRED: this page was opened without a signed session token");
      const { activateBotPage } = await import("@rcai/connector-recall");
      const act = await activateBotPage(botBrokerUrl ?? settings.brokerUrl, botToken);
      this.activated = { sessionId: act.sessionId, botId: act.botId, clientToken: act.clientToken };
    }
    handlers.onActivated?.(this.activated);
    this.meetingStatus = "in_call";
    const attach = this.init.attendeeAttach;
    if (attach) {
      /**
       * Attendee is carrying this page as its voice agent, so meeting audio comes over the relay and the
       * character's voice leaves through the page's own speaker, which Attendee streams. Pushing audio
       * back over the socket as well would double it.
       */
      const { AttendeeConnector } = await import("@rcai/connector-attendee");
      const session = new AttendeeConnector({ brokerUrl: this.init.botBrokerUrl ?? settings.brokerUrl }).attach({ botId: attach.botId || this.activated.botId, clientWsUrl: attach.clientWsUrl });
      this.session = session as unknown as typeof this.session;
      session.onEvent((e) => this.onMeetingEvent(e));
      await this.startPipeline({ micFromMeeting: true });
      return;
    }
    await this.startPipeline({ micFromMeeting: false });
    const feed = this.init.botTranscriptFeed;
    if (feed) {
      this.stopFeed = feed((e) => this.onMeetingTranscript(e.text, e.final, e.speakerName ?? null, e.participantId));
    }
  }

  // ---- shared pipeline -------------------------------------------------------------------------
  private async startPipeline(o: { micFromMeeting: boolean }): Promise<void> {
    const { settings, persona, character, stage, handlers } = this.init;
    // A bot page must talk to the public origins, never to the operator's loopback URLs.
    const brokerUrl = this.init.botBrokerUrl ?? settings.brokerUrl;
    const agentUrl = this.init.botAgentUrl ?? settings.agentUrl;
    const speaker = new SpeakerOutput();
    this.speaker = speaker;
    // A meeting bot page is opened by Recall with no user gesture, so Chrome may hold the AudioContext
    // suspended — and then BOTH `resume()` and the AudioWorklet load stay pending forever. Awaiting them
    // unconditionally strands the whole pipeline before the avatar is ever mounted (observed in-call:
    // Live2D never initialised, the tile stayed blank). Give audio a bounded head start, then continue;
    // the tap attaches on its own as soon as the context is allowed to run.
    await Promise.race([
      (async () => {
        await speaker.resume();
        await speaker.whenReady();
      })().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, AUDIO_START_GRACE_MS)),
    ]);
    void speaker.resume().catch(() => {});
    /**
     * The runtime's own energy VAD is the operator page's instant cut: a headset, one voice, no
     * mixing. On the bot page the same fast path ran on the room mix (Gate #8 run 63: the greeting
     * died after 17 frames, the first answer was cut mid-sentence, and the agent had confirmed no
     * barge-in — a listener's 「えっと」 and a room blip had stopped the character from the page).
     * There the agent's confirmed onset (bargeInConfirmMs) is the only thing that may stop her.
     */
    // Vertex/Gemini Live does not consistently emit a user-speech event for a remote
    // participant while it is already speaking. Keep the local VAD on for bot pages
    // using that provider so the runtime can take the same immediate interruption
    // path as the operator page. The runtime suppresses duplicate provider VAD events.
    const localVad = this.init.role !== "bot" || this.decision.conversation === "google";
    const runtime = new ConversationRuntime({ sink: speaker, localVad });
    this.runtime = runtime;

    const def = await this.resolveCharacter(character);
    this.character = def;
    /**
     * A missing avatar must not cost the meeting its voice. A meeting vendor runs this page in its own
     * browser, and Attendee's launches Chrome with --disable-gpu and no swiftshader override, which in
     * current Chrome means no WebGL and so no Live2D. Heard but not seen beats a session that refuses to
     * start — provided the reason is reported instead of leaving a blank tile and clean logs.
     */
    const avatar = stage ? await this.createAvatar(character, stage, brokerUrl, settings.privacyMode) : null;
    if (stage && avatar) {
      this.avatar = avatar;
      await avatar.prepare(def);
      const avatarRuntime = new AvatarRuntime(avatar, { latency: runtime.latency });
      this.avatarRuntime = avatarRuntime;
      avatarRuntime.onStateChange((t) => handlers.onAvatarState?.(t));
      await avatar.start();
      const planner = new RemoteSemanticPlanner(plannerUrl(this.decision.conversation, { brokerUrl, agentUrl, privacyMode: settings.privacyMode }), 1500);
      const behavior = new BehaviorEngine(avatarRuntime, { planner, mode: persona.mode, baseEmotion: (persona.defaultEmotion as Emotion | undefined) ?? "warm_positive", baseEmotionIntensity: 0.25 });
      this.behavior = behavior;
      behavior.start();
      speaker.tap.subscribe((frame) => avatarRuntime.pushAudio(frame));
    }

    /**
     * The face model. Started after audio, never before: a meeting that can be heard but not watched
     * still works, and the reverse does not. A failure to load is reported and the session continues.
     */
    void this.startVisual();

    runtime.on((e) => this.onConversationEvent(e));

    if (!o.micFromMeeting) {
      // Bot page: getUserMedia is the meeting audio (Recall grants it without a prompt).
      const mic = new MicCapture({ context: speaker.context });
      this.mic = mic;
      const stream = await mic.start();
      mic.onFrame((frame) => this.onMeetingAudio(frame));
      runtime.attachMicStream(stream);
    }

    this.providerOpts = { brokerUrl, agentUrl, privacyMode: settings.privacyMode, expressive: settings.expressive };
    const baseProvider = await createConversationProvider(this.decision.conversation, this.providerOpts);
    const provider = this.usesObserver ? new OnDemandConversation(baseProvider) : baseProvider;
    this.provider = provider as typeof this.provider;
    this.canLookUp = false;
    // What the character may say about today depends on whether this provider can look it up.
    const canSearch = provider.capabilities().extras?.search === true || this.canLookUp;
    this.instructions = (now: string) =>
      `${persona.systemPrompt}\n\n${meetingInstructions({ displayName: this.init.displayName, proactive: this.init.proactivity !== "addressed_only", aliases: this.names, setting: this.setting, canSearch, now })}`;
    const extra = meetingInstructions({ displayName: this.init.displayName, proactive: this.init.proactivity !== "addressed_only", aliases: this.names, setting: this.setting, canSearch, now: localClock(new Date()) });
    const config = createSessionConfig({ persona, character: def, providerId: this.decision.conversation, privacyMode: settings.privacyMode, extra, voiceId: this.voiceId(def?.manifest.id) });
    // Meetings never auto-open: suppress the persona's opening line.
    // A room is not a headset: coughs, backchannels and open mics fire the recogniser's VAD all the
    // time, and each onset used to cut the character mid-sentence (Gate #8 runs 6–7: the greeting
    // died after one audio frame). Speech has to persist before it counts as an interruption.
    // The participation policy decides which utterances are for the character, and `answer()` sends
    // those as text turns. The recogniser must not draft a reply to every room fragment on its own:
    // each draft was cut unsanctioned (Gate #8 run 10: 25 drafts, an LLM call each), and one that
    // began speaking before the sanctioned text arrived was cancelled by it, turn and all.
    /**
     * What is true right now is the one thing the model cannot know, and 「今日のニュースを教えて」 is
     * the most ordinary question there is. The lookup runs in the broker; the character only reads out
     * what comes back.
     */
    if (provider.capabilities().toolCalling && this.init.settings.privacyMode !== "strict_local" && this.activated?.clientToken) {
      config.tools = [...(config.tools ?? []), { ...LIVE_LOOKUP_TOOL, parameters: { ...LIVE_LOOKUP_TOOL.parameters } }];
      this.canLookUp = true;
    }
    config.providerOptions = {
      ...config.providerOptions,
      opening: undefined,
      autoRespond: false,
      bargeInConfirmMs: this.init.role === "bot" ? BOT_BARGE_IN_CONFIRM_MS : undefined,
    };
    await runtime.start(provider, config);
    this.runtimeReady = true;
  }

  private onMeetingEvent(e: MeetingEvent): void {
    const now = Date.now();
    switch (e.type) {
      case "usage":
        this.init.handlers.onUsage?.(e.counters);
        break;
      case "status":
        this.onMeetingStatus(e.status, e.detail, now);
        break;
      case "joined":
        this.onMeetingStatus("in_call", "joined", now);
        break;
      case "left":
        this.onMeetingStatus(e.reason && /^vendor_status:/.test(e.reason) ? this.session?.status() ?? "left" : this.session?.status() ?? "left", e.reason, now);
        break;
      case "audio_muted":
        this.setMuted(e.muted);
        break;
      case "audio":
        /**
         * Per-participant audio is how a conversation gets attached to a person on a vendor whose
         * transcripts carry no name: whoever's stream this frame came from is who is speaking.
         */
        if (e.participantId) this.lastSpeakerId = e.participantId;
        this.onMeetingAudio(e.frame);
        break;
      case "transcript":
        this.onMeetingTranscript(e.text, e.final, e.speakerName ?? null, e.participantId);
        break;
      case "speech_level": {
        let ledger = this.levels.get(e.participantId);
        if (!ledger) {
          ledger = [];
          this.levels.set(e.participantId, ledger);
        }
        ledger.push({ at: e.at, power: 10 ** (e.level / 10) });
        while (ledger.length && ledger[0]!.at < e.at - LEVEL_LEDGER_MS) ledger.shift();
        break;
      }
      case "speech":
        if (e.active) {
          this.lastSpeaker = e.participant.name ?? null;
          this.lastSpeakerId = e.participant.id;
        }
        this.policy.onSpeechActivity(e.active, now, e.participant.name);
        if (!this.forwarding) this.avatarRuntime?.handleEvent({ type: e.active ? "user_speech_started" : "user_speech_ended", at: now });
        break;
      case "error":
        this.init.handlers.onError(e.error.message, "MEETING");
        break;
      case "video_frame":
        void this.onVideoFrame(e.participantId, e.jpegBase64, e.at);
        break;
      default:
        break;
    }
  }

  private onMeetingStatus(status: MeetingStatus, detail: string | undefined, now: number): void {
    const prev = this.meetingStatus;
    this.meetingStatus = status;
    this.init.handlers.onStatus(status, detail);
    if (status === "reconnecting" || status === "waiting_room") {
      // Hold the character: nothing we say can reach the room; the policy restarts clean once we are back.
      this.policy.reset(now);
      this.cut(status);
    }
    if (prev === "reconnecting" && status === "in_call") this.policy.reset(now);
    if (status === "denied" || status === "removed" || status === "ended" || status === "failed" || status === "left") {
      void this.leave(); // cleanup: mic/avatar/provider/speaker; idempotent
    }
  }

  private setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.init.handlers.onMuted?.(muted);
    if (muted) {
      this.policy.reset(Date.now());
      this.cut("muted");
    }
  }

  /** Operator / bot page: the host muted or unmuted the character. */
  reportHostMute(muted: boolean): void {
    const s = this.session as (MeetingSession & { setAudioMuted?(m: boolean): void }) | null;
    if (s?.setAudioMuted) s.setAudioMuted(muted);
    else this.setMuted(muted);
  }

  /** Gate audio only when an independent transcript path was configured for this meeting. */
  private get hasExternalTranscripts(): boolean {
    // Legacy Attendee bot pages also pass a Recall callback, which never yields Attendee captions.
    // Only the explicit observer setting identifies the new authenticated caption relay.
    return this.usesObserver || (this.init.meetingProvider !== "attendee" && !!this.init.botTranscriptFeed);
  }

  /**
   * Meeting audio (48 kHz).
   *
   * When something else transcribes the room, the AI is kept deaf until it is spoken to — cheaper, and
   * it cannot answer a conversation it was not part of. When the AI is the only recogniser it hears
   * everything, because it has to hear its own name, and what the *meeting* hears is gated instead
   * (`assistant_audio` below).
   */
  onMeetingAudio(frame: PCMFrame): void {
    /**
     * Three separate live failures have come down to "did the character hear anything at all", and a
     * bot page has no operator to ask. One line, once, is cheap and has paid for itself.
     */
    this.heard++;
    this.heardMs += (frame.data.length * 1000) / frame.sampleRate;
    if (this.lastHeardAt && frame.timestamp - this.lastHeardAt > 250) this.gaps++;
    this.lastHeardAt = frame.timestamp;
    let silent = true;
    for (let i = 0; i < frame.data.length; i++) if (frame.data[i] !== 0) { silent = false; break; }
    if (silent) this.zeroFrames++;
    if (!this.heardAnything) {
      this.heardAnything = true;
      console.log("[rcai:bot] first meeting audio", JSON.stringify({ rate: frame.sampleRate, samples: frame.data.length }));
    }
    /**
     * The first frame of room audio is the moment the character is actually in the call — the
     * vendor's "in_call" arrives when the audio socket opens, which on a bot page is before anyone has
     * admitted it. Greet once, a beat later, so the first thing the room hears is not the character
     * speaking over the click of the admit button. Bot role only: an operator page's first frame is
     * the operator's own microphone.
     *
     * Not before the AI is connected, though. Admission can land while `startPipeline` is still
     * opening the agent socket, and a greeting sent then is dropped on the floor (Gate #8 run 9);
     * the frames keep coming, so the greeting simply waits for the first one after the connection.
     */
    if (this.init.role === "bot" && !this.greeted && this.runtimeReady && this.outboundAllowed) {
      this.greeted = true;
      setTimeout(() => {
        const now = this.policy.onJoined(Date.now());
        console.log("[rcai:bot] greeting", now ? "now" : `deferred (${this.policy.state})`);
        this.report("greeting", { now, state: this.policy.state });
      }, 1500);
    }
    const level = dbfs(rms(frame.data));
    this.behavior?.reportUserAudio(Math.max(0, Math.min(1, (level + 50) / 35)), frame.timestamp);
    const allowed = this.hasExternalTranscripts ? this.policy.state === "ADDRESSED" || this.policy.state === "RESPONDING" : true;
    if (allowed !== this.forwarding) this.forwarding = allowed;
    // The avatar stays alive either way: a character that freezes while someone talks looks broken.
    for (const ev of this.vad.process(frame)) {
      this.policy.onSpeechActivity(ev.type === "speech_start", frame.timestamp);
      this.avatarRuntime?.handleEvent({ type: ev.type === "speech_start" ? "user_speech_started" : "user_speech_ended", at: frame.timestamp });
    }
    if (allowed) {
      this.forwarded++;
      this.runtime?.pushMicFrame(frame);
    }
  }

  /**
   * Whose words the recogniser just delivered. The last stream to go active is a guess that an open
   * mic beats: Gate #8 run 71 had a host's microphone carrying a television, its stream flickering
   * above the floor every few seconds, and the Tester's 「ゆい、今日の予定を教えて」 was attached to
   * whoever had flickered last — after which the television's 「服濡れちゃ…」 was an engaged follow-up
   * from the person she had answered, and got an answer. Loudness over the utterance decides instead:
   * the speaker is whoever put the most energy on their own stream while the recogniser's VAD was
   * open, provided they clearly outweigh the runner-up. No ledger (no per-participant streams, a
   * listener role) or no clear winner: the old guess stands.
   */
  private attribute(now: number): string | undefined {
    if (this.levels.size === 0) return undefined;
    const u = this.utterance;
    const fresh = u && now - (u.to ?? u.from) < 4000;
    // The VAD fires a little after the sound reached this page; the stream's level did not.
    const from = fresh ? u.from - 500 : now - 3500;
    const to = fresh ? (u.to ?? now) : now;
    let best: { id: string; power: number } | null = null;
    let second = 0;
    for (const [id, ledger] of this.levels) {
      let power = 0;
      for (const l of ledger) if (l.at >= from && l.at <= to) power += l.power;
      if (power <= 0) continue;
      if (!best || power > best.power) {
        second = best?.power ?? 0;
        best = { id, power };
      } else if (power > second) second = power;
    }
    if (!best || best.power < second * ATTRIBUTION_MARGIN) return undefined;
    return best.id;
  }

  /**
   * `participantId` is what keeps a conversation attached to one person: the engagement layer answers
   * follow-ups from whoever called the character, and only from them. A display name is the fallback
   * when the vendor gives no id — two people called 「田中」 would share one conversation, which is
   * still better than every turn needing the name again.
   */
  onMeetingTranscript(text: string, final: boolean, speakerName: string | null, participantId?: string, utterance?: number): void {
    if (final) this.transcripts++;
    if (final && !this.sawTranscript) {
      this.sawTranscript = true;
      console.log("[rcai:bot] first transcript", JSON.stringify({ text: text.slice(0, 40), speakerName, participantId }));
    }
    const now = Date.now();
    const line: MeetingTranscriptLine = { id: ++this.lineId, speaker: speakerName ?? "?", text, final, at: now };
    this.init.handlers.onTranscript(line);
    // Remembered before the policy hears it: a turn this line triggers reads its context synchronously
    // from the transition, and with the push after, the line dropped as "the address" was the one
    // before it — the answer to 「ゆい、今どう思う？」 never saw the remark it was about.
    if (final) {
      this.meetingMemory.observe(line.speaker, text);
      this.recent.push({ speaker: line.speaker, text, utterance, participantId, line });
      while (this.recent.length > 12) this.recent.shift();
    }
    this.feeding = utterance;
    const detection = this.policy.onTranscript({ text, final, speakerName, participantId }, now);
    if (final && this.init.role === "bot") this.report("address_decision", {
      utterance, characters: text.length, addressed: detection?.addressed ?? false,
      reason: detection?.reason ?? "ignored self transcript", state: this.policy.state,
      sanctioned: this.sanctioned,
    });
    this.feeding = undefined;
    // Entering ADDRESSED is handled by the transition listener, whatever caused it.
  }

  /**
   * The recogniser's second, better reading of a line it already delivered. Context only: the words a
   * later turn will see, and the line on screen. The policy never hears it — the turn decision was
   * taken on the first reading, and a second one arriving a second later must not become a second turn.
   */
  private reviseTranscript(utterance: number, text: string): { entry: RecentLine; was: string } | null {
    const r = this.recent.find((x) => x.utterance === utterance);
    if (!r || !text.trim()) return null;
    const was = r.text;
    r.text = text;
    r.line = { ...r.line, text };
    this.init.handlers.onTranscript(r.line);
    return { entry: r, was };
  }

  /**
   * The better reading as a second opinion on a turn taken on the first. Gate #8 run 78 pass 3:
   * 「ユが昨日そう言ってたよね。」 lost the name, read as a follow-up from the person the character was
   * talking with, and was answered; the rescore 1.9 s later read 「ユイが昨日そう言ってたよね」 — talk
   * *about* the character, the one thing a follow-up is never allowed to be — and the answer's audio
   * started 4 s after that. A follow-up the better reading contradicts is withdrawn while the answer
   * is still a draft. Only that kind: a turn on the name was heard by name, the greeting was never a
   * reading, and once the character is speaking the turn stands — a sentence cut off by its own
   * second thoughts is worse than a wrong one. Never a *second* turn on the same words.
   */
  private secondOpinion(utterance: number, text: string, was: string, entry: RecentLine, now: number): void {
    // A follow-up held on a fragment (run 109: 「いいが、昨日そう言ってたよね」) is decided by this reading.
    const held = this.policy.reviseHeld(was, text, now);
    if (held) {
      if (this.init.role === "bot") console.log(`[rcai:bot] held follow-up ${held}:`, JSON.stringify(text.slice(0, 80)));
      return;
    }
    const d = this.policy.detect(text);
    if (this.init.role === "bot") this.report("address_revision", {
      utterance, characters: text.length, addressed: d.addressed, reason: d.reason,
      state: this.policy.state, sanctioned: this.sanctioned,
    });
    const turn = this.turnOf;
    /**
     * The other direction. Run 79: 「唯イ寮の予定を教えて。」 earned nothing — the name was not in it —
     * and the rescore 1.4 s later read 「ゆい、今日の予定を教えて」. The person called the character by
     * name and got silence. A first reading that was not an address, a better one that is, and no
     * turn taken meanwhile: the better reading is handed to the policy as the line it should have
     * heard. Only the name earns this — a follow-up or an open-conversation turn on a rescore would be
     * the "second turn" this path must never produce.
     */
    if (turn?.utterance !== utterance && d.addressed && !this.policy.detect(was).addressed && (this.policy.state === "OBSERVING" || this.policy.state === "LISTENING")) {
      if (this.init.role === "bot") console.log("[rcai:bot] late turn on the rescore:", d.reason, JSON.stringify(text.slice(0, 80)));
      this.feeding = utterance;
      this.policy.onTranscript({ text, final: true, speakerName: entry.speaker === "?" ? null : entry.speaker, participantId: entry.participantId }, now);
      this.feeding = undefined;
      return;
    }
    if (!turn || turn.utterance !== utterance || turn.reason !== "engaged follow-up") return;
    if (!this.sanctioned || this.policy.state !== "ADDRESSED") return;
    if (d.addressed || !d.reason.startsWith("name mentioned")) return;
    if (this.init.role === "bot") {
      console.log("[rcai:bot] turn withdrawn:", d.reason, JSON.stringify(text.slice(0, 80)));
      this.report("withdrawn", { utterance, text: text.slice(0, 120), reason: d.reason });
    }
    this.clearAnswerWatchdog();
    this.sanctioned = false;
    this.turnOf = null;
    this.policy.withdraw(now, `withdrawn: ${d.reason}`);
    // The draft dies with the turn; the `interrupted` that comes back finds nothing sanctioned.
    void this.runtime?.interrupt();
  }

  /** Send an opted-in image on a gesture from the engaged participant, at most once per five seconds. */
  private maybeShowModel(participantId: string, jpegBase64: string, at: number, cue: VisualCue): void {
    const rt = this.runtime;
    if (!rt || !this.init.vision) return;
    if (this.policy.engagedWith?.participantId !== participantId) return;
    if (at - this.lastVisionAt < VISION_MIN_INTERVAL_MS) return;
    // Event-driven snapshots only, never a steady stream while the participant speaks.
    if (!(cue.nodded || cue.shookHead || cue.tilted)) return;
    this.lastVisionAt = at;
    this.shownToModel++;
    rt.pushImage({ data: jpegBase64, mimeType: "image/jpeg" });
  }

  /** Loads the face model in the background; a failure is named, never silent, and never fatal. */
  private async startVisual(): Promise<void> {
    if (this.visual || this.init.visualCues === false) return;
    const v = new VisualPerceptionService();
    this.visual = v;
    await v.start();
    if (!v.ready && v.blockedReason) this.init.handlers.onError(v.blockedReason, "VISUAL");
  }

  /**
   * What the camera shows, as observations the model may respond to — never as conclusions about a
   * person. "Smiling" is a fact about a face; "happy" is a claim about someone's mind, and a model
   * told the second one will say it out loud to a person in a meeting. Only the participant the
   * character is talking with is described, and only when the measurement is worth stating.
   */
  private visualContext(): string {
    const engaged = this.policy.engagedWith?.participantId;
    const cue = engaged ? this.cues.get(engaged) : undefined;
    if (!cue || !cue.facePresent || cue.confidence < 0.6) return "";
    const parts: string[] = [];
    if (cue.nodded) parts.push("うなずいた");
    if (cue.shookHead) parts.push("首を横に振った");
    if (cue.tilted) parts.push("首をかしげている");
    if (cue.smile > 0.5) parts.push("笑顔がある");
    if (cue.browRaise > 0.6) parts.push("眉が上がっている");
    if (cue.lookingForward < 0.35) parts.push("視線がそれている");
    if (!parts.length) return "";
    return `【見えていること（確実ではない観測。相手の心情を断定しないこと）】${parts.join("・")}`;
  }

  /**
   * A webcam frame for one participant. The face model runs here, in the page, over Attendee's 2 fps
   * stream: a nod is an answer, and a character that only hears words misses half of what a person
   * says. A frame that cannot be measured is skipped rather than guessed at.
   */
  private async onVideoFrame(participantId: string, jpegBase64: string, at: number): Promise<void> {
    if (!this.visual?.ready) return;
    const cue = await this.visual.onFrame(participantId, jpegBase64, at);
    if (!cue) return;
    this.cues.set(participantId, cue);
    this.cueCount++;
    if (cue.facePresent) this.faceCount++;
    this.maybeShowModel(participantId, jpegBase64, at, cue);
    // The avatar mirrors the room a little: a person smiling is met with a warmer face, not a report.
    if (cue.smile > 0.55 && cue.confidence > 0.6) this.avatarRuntime?.setEmotion("warm_positive", Math.min(0.5, cue.smile));
    this.policy.onVisualCue(cue, Date.now());
  }

  /** Hand the addressing utterance (plus recent context) to the AI as text — provider-agnostic. */
  /**
   * Run a tool the model asked for and hand the result back. Only the lookup exists, and only what it
   * returns is sent on: a tool nobody declared, or arguments that are not a lookup, get an error the
   * model can say out loud rather than an empty result it will fill in itself.
   */
  private async runTool(call: { id: string; name: string; arguments: Record<string, unknown> }): Promise<void> {
    const a = this.activated;
    const respond = (response: Record<string, unknown>) => this.runtime?.sendToolResponse([{ id: call.id, name: call.name, response }]);
    if (call.name !== LIVE_LOOKUP_TOOL.name || !a?.clientToken) return respond({ error: `unknown tool ${call.name}` });
    const req = parseLookupArguments(call.arguments);
    if (!req) return respond({ error: "kind must be news or weather" });
    this.lookups.asked++;
    const base = (this.init.botBrokerUrl ?? this.init.settings.brokerUrl).replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/api/meeting/session/${encodeURIComponent(a.sessionId)}/lookup`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${a.clientToken}` },
        body: JSON.stringify(req),
      });
      const result = (await res.json()) as LiveLookupResult;
      if ((result.facts ?? []).length) this.lookups.answered++;
      if (this.init.role === "bot") console.log("[rcai:bot] lookup", JSON.stringify({ kind: req.kind, facts: result.facts?.length ?? 0, error: result.error }));
      this.report("lookup", { kind: req.kind, facts: result.facts?.length ?? 0, error: result.error });
      respond(renderLookup(result));
    } catch (err) {
      respond({ error: err instanceof Error ? err.message.slice(0, 120) : "lookup failed" });
    }
  }

  private async answer(): Promise<void> {
    const rt = this.runtime;
    const by = this.policy.addressedBy;
    if (!rt || !by) return;
    if (!this.outboundAllowed) {
      // muted / waiting room / reconnecting: we cannot be heard — do not generate speech into the void.
      this.policy.onAssistantDone(Date.now());
      return;
    }
    // The addressing line is handed over separately; everything else it heard is the context.
    const last = this.recent[this.recent.length - 1];
    // The model knows the character by one name; the transcript spells it as heard (「ゆイ」, 「結衣」).
    const canon = (t: string) => canonicalizeName(t, this.init.displayName, this.names);
    const history = last && by.text && last.text === by.text ? this.recent.slice(0, -1) : this.recent;
    const context = (this.usesObserver ? history.slice(-6) : history).map((r) => `${r.speaker}: ${this.usesObserver ? canon(r.text).slice(0, 400) : canon(r.text)}`);
    if (this.usesObserver) context.unshift(this.meetingMemory.context());
    const seen = this.visualContext();
    const prompt = by.detection.reason === JOINED_REASON
      ? meetingGreetingPrompt(this.init.displayName)
      : meetingTurnPrompt({ context, seen, displayName: this.init.displayName, now: localClock(new Date()), setting: this.setting, asked: by.text ? { speakerName: by.speakerName, text: canon(by.text) } : { reaction: by.detection.reason } });
    this.avatarRuntime?.handleEvent({ type: "assistant_thinking" });
    try {
      await rt.sendText(prompt, { hidden: true });
    } catch (err) {
      this.init.handlers.onError(err instanceof Error ? err.message : String(err), "PROVIDER");
      this.releaseTurn("send failed");
      return;
    }
    this.armAnswerWatchdog();
  }

  private armAnswerWatchdog(): void {
    this.clearAnswerWatchdog();
    this.answerTimer = setTimeout(() => {
      this.answerTimer = null;
      if (this.sanctioned && this.policy.state === "ADDRESSED") this.releaseTurn("stalled");
    }, ANSWER_STALL_MS);
  }

  private dropThinkingTurn(now: number): void {
    if (this.init.role === "bot") this.report("interrupted", { frames: 0, phase: "thinking" });
    this.clearAnswerWatchdog();
    this.sanctioned = false;
    this.policy.onInterrupted(now);
  }

  private clearThinkingBarge(): void {
    if (this.thinkingBargeTimer) clearTimeout(this.thinkingBargeTimer);
    this.thinkingBargeTimer = null;
  }

  private clearAnswerWatchdog(): void {
    this.clearThinkingBarge();
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = null;
  }

  /** The sanctioned turn ends without an answer: the floor is open again for the next address. */
  private releaseTurn(reason: string): void {
    this.clearAnswerWatchdog();
    if (this.init.role === "bot") {
      console.log("[rcai:bot] turn released:", reason);
      this.report("released", { reason, state: this.policy.state });
    }
    this.sanctioned = false;
    if (this.policy.state === "ADDRESSED" || this.policy.state === "RESPONDING") this.policy.onAssistantDone(Date.now());
  }

  private publishUsage(counters: Record<string, number>, force = false): void {
    if (counters.estimatedMicroUsd === undefined) return;
    const totals = { ...counters };
    for (const key of ["estimatedMicroUsd", "pricedTurns", "unpricedTurns", "inputAudioSeconds", "outputAudioSeconds", "imageCount", "liveActiveSeconds"]) totals[key] = (this.usageBase[key] ?? 0) + (counters[key] ?? 0);
    totals.contextPeakTokens = Math.max(this.usageTotals.contextPeakTokens ?? 0, counters.contextPeakTokens ?? 0);
    this.usageTotals = totals;
    this.init.handlers.onUsage?.(totals);
    if (force || Date.now() - this.usageReportedAt >= 60000) {
      this.usageReportedAt = Date.now();
      this.report("ai_usage", totals);
    }
  }

  private onConversationEvent(e: ConversationEvent): void {
    const now = Date.now();
    this.avatarRuntime?.handleEvent(e);
    this.behavior?.handleEvent(e);
    this.init.handlers.onEvent?.(e);
    switch (e.type) {
      case "usage":
        this.publishUsage(e.counters, true);
        break;
      case "tool_call":
        void this.runTool(e.call);
        break;
      case "user_transcript":
        /**
         * The AI's recogniser is the only one on this path, so its transcripts are what the policy
         * hears. Shown as a meeting line too — otherwise the operator sees a character answering
         * something nobody can read.
         */
        if (!this.hasExternalTranscripts && e.final !== false && e.text.trim()) {
          this.providerTranscriptTurn = this.decision.conversation === "google" || this.decision.conversation === "openai";
          try {
            this.onMeetingTranscript(e.text, true, this.lastSpeaker, this.attribute(now) ?? this.lastSpeakerId, e.id);
          } finally {
            this.providerTranscriptTurn = false;
          }
        }
        break;
      case "user_transcript_revised":
        if (!this.hasExternalTranscripts) {
          this.providerTranscriptTurn = this.decision.conversation === "google" || this.decision.conversation === "openai";
          try {
            const revised = this.reviseTranscript(e.id, e.text);
            if (revised) this.secondOpinion(e.id, e.text, revised.was, revised.entry, now);
          } finally {
            this.providerTranscriptTurn = false;
          }
        }
        break;
      case "assistant_speech_started":
        /**
         * A provider that answers on its own started talking without being asked. Stop it rather than
         * let it run: the audio is muted either way, and a model talking into a muted channel costs
         * tokens and leaves the character mid-sentence when it is finally spoken to.
         */
        // A provider that does its own turn-taking beats the policy's timer to the same conclusion in
        // a one-to-one: adopt its turn instead of cutting the only answer the character gives.
        this.answers++;
        if (!this.sanctioned) this.policy.acceptSelfTurn(now);
        if (!this.sanctioned) {
          this.cut("unsanctioned");
          break;
        }
        this.clearAnswerWatchdog();
        this.policy.markResponding(now);
        if (this.init.role === "bot") this.report("speaking", { state: this.policy.state });
        this.spokeText = "";
        this.spokeSeconds = 0;
        break;
      case "assistant_audio":
        /**
         * The character generates an answer for every utterance when it is its own recogniser — a
         * local agent is a full conversation loop and does not know about participation policy. The
         * meeting hears it only when the policy says it was actually spoken to; otherwise it is
         * thinking out loud, which is not the same thing as taking a turn.
         */
        /**
         * Two ways out of this page, and only one of them can be checked from here.
         *
         *   page   the vendor captures the page's own speaker (its webpage streamer does this for
         *          video and audio together). Nothing crosses our own code, so nothing we log can
         *          tell whether it worked — and in the first live run with a working page, a working
         *          relay and 38k audio chunks arriving, the room heard nothing.
         *   socket the character's audio goes back the way the meeting's audio came, over the relay
         *          we own and count.
         *
         * Sending both is the one combination that is definitely wrong: the character would be heard
         * twice, half a second apart. So it is a choice, and the default is the one that can be
         * measured.
         */
        if (this.outboundAllowed && this.sanctioned && (this.policy.state === "ADDRESSED" || this.policy.state === "RESPONDING")) {
          this.spokeFrames++;
          this.spokeSeconds += e.frame.data.length / e.frame.sampleRate;
          if (!this.init.attendeeAttach || this.init.outboundPath !== "page") this.session?.pushOutboundAudio(e.frame);
        }
        break;
      case "assistant_transcript":
        // Phrases arrive as partials while they play; the final carries the whole reply and replaces them.
        if (this.sanctioned) this.spokeText = e.final !== false ? e.text : this.spokeText + e.text;
        if (e.final !== false) this.init.handlers.onTranscript({ id: ++this.lineId, speaker: this.init.displayName, text: e.text, final: true, at: now, self: true });
        break;
      case "assistant_speech_ended":
        void this.session?.endOutboundUtterance?.();
        // What was said and how much audio it took: the unattended gate reads the text for a parroted
        // name and the seconds against what the room actually heard (a stretch means underruns).
        if (this.init.role === "bot" && this.sanctioned) this.report("spoke", { frames: this.spokeFrames, seconds: Math.round(this.spokeSeconds * 100) / 100, text: this.spokeText.slice(0, 200) });
        this.clearAnswerWatchdog();
        this.sanctioned = false;
        if (this.policy.state === "RESPONDING" || this.policy.state === "ADDRESSED") this.policy.onAssistantDone(now);
        break;
      case "user_speech_started":
        this.utterance = { from: now, to: null };
        /**
         * Someone spoke up between the policy sanctioning a turn and the answer starting. The agent
         * treats it as a barge-in on its own thinking and will answer whatever comes next instead —
         * an answer nobody sanctioned. The turn is over; the next transcript earns its own.
         *
         * If it was speech. This event is the runtime's own VAD on the room mix, which fires on the
         * onset — the agent holds the same onset for `bargeInConfirmMs` before it counts. A 200 ms
         * click 600 ms after the greeting was sanctioned ended it before a word was said (Gate #8
         * run 13); the bot page waits the same window, and speech that ends inside it never happened.
         */
        if (this.sanctioned && this.policy.state === "ADDRESSED") {
          if (this.init.role !== "bot") {
            this.dropThinkingTurn(now);
            break;
          }
          this.clearThinkingBarge();
          this.thinkingBargeTimer = setTimeout(() => {
            this.thinkingBargeTimer = null;
            if (this.sanctioned && this.policy.state === "ADDRESSED") this.dropThinkingTurn(Date.now());
          }, BOT_BARGE_IN_CONFIRM_MS);
        }
        break;
      case "user_speech_ended":
        if (this.utterance) this.utterance.to = now;
        this.clearThinkingBarge();
        break;
      case "interrupted":
        /**
         * Cut off mid-sentence. The audio has already stopped — that is the runtime's fast path and not
         * a decision made here. What matters to the conversation is that this was not a turn the
         * character completed: the floor belongs to whoever cut in, the conversation stays open, and
         * the consecutive-turn count must not be spent on an answer nobody heard.
         *
         * Unless nothing of ours was cut. A local agent drafts an answer to every utterance on its own,
         * and the text turn this page sends for a sanctioned one cancels that draft first — the agent
         * reports it as an interruption, of a generation the room never heard. Taking that as the end
         * of our turn made the page cut its own answer the moment it started (Gate #8 runs 6–8: every
         * 「ゆい、…」 was followed by `interrupted` then `cut unsanctioned`). Before the answer has
         * started, an interruption is the draft dying, and the sanction is for the answer still to come.
         */
        if (this.sanctioned && this.policy.state === "ADDRESSED") {
          if (this.init.role === "bot") console.log("[rcai:bot] draft cancelled, turn still ours");
          break;
        }
        void this.session?.endOutboundUtterance?.();
        // What she had said when cut: the harness reads a reply from here too (run 63: three cut answers, 0 read).
        if (this.init.role === "bot" && this.sanctioned) this.report("interrupted", { frames: this.spokeFrames, text: this.spokeText.slice(0, 200) });
        this.clearAnswerWatchdog();
        this.sanctioned = false;
        this.policy.onInterrupted(now);
        break;
      case "error":
        this.init.handlers.onError(e.error.message, "PROVIDER");
        break;
      case "session_closed":
        this.onAgentClosed(now, e.reason);
        break;
      default:
        break;
    }
  }

  /**
   * The AI's session closed while the meeting goes on. Whatever turn was in flight is lost — the
   * policy hears that as an interruption so it does not wait on an answer — and a new session is
   * brought up behind the same avatar and speaker (`switchProvider`: same config, same system prompt
   * as last updated). `leave()` closes the session too; that one is ours and is left alone.
   */
  private onAgentClosed(now: number, reason?: string): void {
    if (this.disposed || this.reconnecting || !this.runtimeReady || !this.runtime || !this.providerOpts) return;
    this.runtimeReady = false;
    this.reconnecting = true;
    const lost = this.sanctioned;
    if (this.init.role === "bot") console.log("[rcai:bot] agent session closed", JSON.stringify({ reason, state: this.policy.state, sanctioned: lost }));
    this.report("agent_closed", { reason, state: this.policy.state, sanctioned: lost });
    if (lost) {
      this.clearAnswerWatchdog();
      this.sanctioned = false;
      this.policy.onInterrupted(now);
    }
    void this.reconnectAgent(now);
  }

  private async reconnectAgent(since: number): Promise<void> {
    for (let attempt = 0; !this.disposed; attempt++) {
      const wait = AGENT_RECONNECT_BACKOFF_MS[Math.min(attempt, AGENT_RECONNECT_BACKOFF_MS.length - 1)];
      await new Promise((r) => setTimeout(r, wait));
      if (this.disposed || !this.runtime || !this.providerOpts) break;
      try {
        this.usageBase = { ...this.usageTotals };
        const baseProvider = await createConversationProvider(this.decision.conversation, this.providerOpts);
        const provider = this.usesObserver ? new OnDemandConversation(baseProvider) : baseProvider;
        await this.runtime.switchProvider(provider);
        this.provider = provider as typeof this.provider;
        // A WebRTC provider (OpenAI) takes the page's mic as a track, which the new peer must be given again.
        const stream = this.mic?.mediaStream;
        if (stream) this.runtime.attachMicStream(stream);
        this.runtimeReady = true;
        this.reconnecting = false;
        const afterMs = Date.now() - since;
        if (this.init.role === "bot") console.log("[rcai:bot] agent session reconnected", JSON.stringify({ attempts: attempt + 1, afterMs }));
        this.report("agent_reconnected", { attempts: attempt + 1, afterMs });
        return;
      } catch (err) {
        if (this.init.role === "bot") console.warn("[rcai:bot] agent reconnect failed:", (err as Error).message);
      }
    }
    this.reconnecting = false;
  }

  /** Operator: mute the character (back to observing). */
  hush(): void {
    this.policy.reset(Date.now());
    this.cut("hush");
  }

  /** Stop whatever the character is saying, and tell the broker why (a bot's log is all we get from a room). */
  private cut(reason: string): void {
    this.cuts++;
    if (this.init.role === "bot") {
      console.log("[rcai:bot] cut", JSON.stringify({ reason, state: this.policy.state, sanctioned: this.sanctioned }));
      this.report("cut", { reason, state: this.policy.state, sanctioned: this.sanctioned });
    }
    void this.runtime?.interrupt();
  }

  status(): MeetingStatus {
    return this.session?.status() ?? this.meetingStatus ?? (this.init.role === "bot" ? "in_call" : "created");
  }

  get activation(): { sessionId: string; botId: string } | null {
    return this.activated;
  }

  async leave(): Promise<void> {
    if (this.disposed) { await this.session?.leave(); return; }
    this.disposed = true;
    if (this.policyTimer) clearInterval(this.policyTimer);
    this.clearAnswerWatchdog();
    this.stopFeed?.();
    this.behavior?.stop();
    await this.runtime?.stop().catch(() => {});
    const usage = this.provider?.usageSnapshot?.();
    if (usage) this.publishUsage(usage, true);
    await this.mic?.stop().catch(() => {});
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.drawLoop !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.drawLoop);
    this.drawLoop = null;
    this.visual?.stop();
    this.visual = null;
    this.cues.clear();
    await this.avatarRuntime?.dispose().catch(() => {});
    await this.speaker?.close().catch(() => {});
    await this.session?.leave();
  }

  private async resolveCharacter(entry: CharacterEntry): Promise<CharacterDefinition> {
    if (entry.renderer === "live2d" || entry.renderer === "vrm" || entry.renderer === "canvas") return loadCharacter(entry.baseUrl);
    return {
      manifest: { id: entry.id, name: entry.name, renderer: entry.renderer, defaultPersona: entry.defaultPersona ?? "friendly", supportedLanguages: ["ja-JP", "en-US"], motionProfile: "vendor", voiceProfiles: [] },
      baseUrl: entry.baseUrl,
      model: entry.id,
      expressions: {},
      motions: {},
      voice: { characterId: entry.id, voices: {} },
    };
  }
}

/** "2026-09-07 02:05" in the page's own time zone — the one live fact the character may state. */
export function localClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
