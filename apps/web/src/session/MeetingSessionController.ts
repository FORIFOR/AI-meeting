import { EnergyVAD, MicCapture, SpeakerOutput, dbfs, rms, type PCMFrame } from "@rcai/audio-core";
import { ConversationRuntime, type ConversationEvent, type ProviderId } from "@rcai/conversation-core";
import { AvatarRuntime, loadCharacter, type AvatarProvider, type CharacterDefinition, type Emotion, type StateTransition } from "@rcai/avatar-core";
import { BehaviorEngine, RemoteSemanticPlanner } from "@rcai/behavior-engine";
import { createSessionConfig, type Persona } from "@rcai/persona-core";
import { JOINED_REASON, ParticipationPolicy, type MeetingEvent, type MeetingSession, type MeetingStatus, type PolicyTransition, type Proactivity } from "@rcai/meeting-core";
import type { VisualCue } from "@rcai/visual-core";
import { VisualPerceptionService } from "./VisualPerceptionService.js";
import { createAvatarProvider, createConversationProvider, createMeetingConnector, plannerUrl, type CharacterEntry } from "../integrations/registry.js";
import { chosenVoice, decide, type Availability, type Settings } from "../state/settings.js";

/** Gemini Live takes at most 1 fps, and every frame costs tokens whether or not it changes anything. */
const VISION_MIN_INTERVAL_MS = 1000;

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
  private recent: { speaker: string; text: string }[] = [];
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
  private forwarded = 0;
  private transcripts = 0;
  private spokeFrames = 0;
  /**
   * Did the policy decide to take this turn?
   *
   * A provider like Gemini Live hears the room continuously and answers whenever it feels addressed —
   * it knows nothing about a participation policy. Gating on "the character is currently speaking"
   * therefore lets it into any conversation it overhears: measured, it spoke while the policy sat in
   * PASSIVE. The gate is the decision, not the symptom of one.
   */
  private sanctioned = false;
  /** The arrival greeting has been scheduled (once per page, never per reconnect). */
  private greeted = false;
  private cueCount = 0;
  private faceCount = 0;
  private shownToModel = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastSpeaker: string | null = null;
  private lastSpeakerId: string | undefined;

  /** Never throws: an avatar that will not load is reported and the meeting continues with the voice. */
  private async createAvatar(character: CharacterEntry, stage: HTMLElement, brokerUrl: string, privacyMode: Settings["privacyMode"]): Promise<AvatarProvider | null> {
    try {
      const framing = this.init.framing ?? (this.init.role === "bot" ? "meeting" : "default");
      return await createAvatarProvider(character.renderer, { container: stage, brokerUrl, privacyMode, framing });
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
  /** Frames drawn since the last heartbeat — the page's render rate, which is what the room's tile is made of. */
  private drawn = 0;
  private drawLoop: number | null = null;
  private lastBeatAt = 0;

  constructor(private readonly init: MeetingInit) {
    this.decision = decide(init.settings, init.availability);
    // Aliases matter in Japanese meetings: STT writes 「ゆい」, never "Yui".
    const names = [init.displayName, init.character.name, ...(init.character.aliases ?? [])].filter(Boolean);
    this.policy = new ParticipationPolicy({ names, proactivity: init.proactivity });
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
        if (this.init.role === "bot") {
          const turn = { reason: t.reason, text: this.policy.addressedBy?.text ?? "" };
          console.log("[rcai:bot] turn", JSON.stringify(turn));
          this.report("turn", turn);
        }
        void this.answer();
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
    this.heartbeat = setInterval(() => {
      const t = performance.now();
      const fps = this.lastBeatAt ? Math.round((this.drawn * 1000) / Math.max(1, t - this.lastBeatAt)) : null;
      this.drawn = 0;
      this.lastBeatAt = t;
      const beat = {
        heard: this.heard, forwarded: this.forwarded, transcripts: this.transcripts, spoke: this.spokeFrames,
        cues: this.cueCount, faces: this.faceCount, shown: this.shownToModel, sanctioned: this.sanctioned,
        state: this.policy.state, engagement: this.policy.engagementState, status: this.meetingStatus,
        fps, avatar: this.avatarFailure ?? (this.avatar ? "ok" : "none"),
      };
      console.log("[rcai:bot] " + JSON.stringify(beat));
      this.report("heartbeat", beat);
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
    const runtime = new ConversationRuntime({ sink: speaker, localVad: true });
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

    const provider = await createConversationProvider(this.decision.conversation, { brokerUrl, agentUrl, privacyMode: settings.privacyMode, expressive: settings.expressive });
    /**
     * The visual half of the instructions matters as much as the conversational half: a model handed
     * face measurements will otherwise narrate them back as psychology — 「不安そうですね」 — to a real
     * person in a real meeting. Cues are uncertain observations that may earn a reply, never a
     * diagnosis, and never something to say out loud.
     */
    const proactive = this.init.proactivity !== "addressed_only";
    const extra =
      `あなたはオンライン会議に参加している「${this.init.displayName}」です。簡潔に（1〜2文で）答えます。` +
      (proactive ? "会話に自然に参加しますが、人が話している間は割り込みません。" : "会議の参加者に名前で呼ばれたときだけ答え、呼ばれていない間は発言しません。") +
      "一度話しかけられたら、その相手との会話が続く間は名前で呼ばれなくても応じます。" +
      "カメラから得た情報（うなずき・首振り・表情・視線）は不確実な観測です。相手の感情や心理状態を断定しない（「不安そう」「怒っている」などと言わない）。" +
      "うなずきや首振りは、言葉がなくても返事として扱ってよい。";
    const config = createSessionConfig({ persona, character: def, providerId: this.decision.conversation, privacyMode: settings.privacyMode, extra, voiceId: this.voiceId(def?.manifest.id) });
    // Meetings never auto-open: suppress the persona's opening line.
    // A room is not a headset: coughs, backchannels and open mics fire the recogniser's VAD all the
    // time, and each onset used to cut the character mid-sentence (Gate #8 runs 6–7: the greeting
    // died after one audio frame). Speech has to persist before it counts as an interruption.
    config.providerOptions = { ...config.providerOptions, opening: undefined, bargeInConfirmMs: this.init.role === "bot" ? BOT_BARGE_IN_CONFIRM_MS : undefined };
    await runtime.start(provider, config);
  }

  private onMeetingEvent(e: MeetingEvent): void {
    const now = Date.now();
    switch (e.type) {
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

  /**
   * Does anything except the AI transcribe this meeting?
   *
   * Recall's bot has its own transcript socket, so the policy can hear the character's name without the
   * AI hearing anything. Attendee has no such stream — the only recogniser in the path is the AI's own.
   * Gating audio on "have we been addressed" there is a deadlock: no audio, so no transcript, so never
   * addressed, so no audio. It cost a live meeting to find, and the character sat there thinking.
   */
  private get hasExternalTranscripts(): boolean {
    // Not "was a feed passed in": a bot page always gets one, and on Attendee it never yields anything
    // because Attendee has no transcript stream. Keying on the callback made the deadlock survive the
    // fix for it.
    return this.init.meetingProvider !== "attendee" && !!this.init.botTranscriptFeed;
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
     */
    if (this.init.role === "bot" && !this.greeted && this.runtime && this.outboundAllowed) {
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
   * `participantId` is what keeps a conversation attached to one person: the engagement layer answers
   * follow-ups from whoever called the character, and only from them. A display name is the fallback
   * when the vendor gives no id — two people called 「田中」 would share one conversation, which is
   * still better than every turn needing the name again.
   */
  onMeetingTranscript(text: string, final: boolean, speakerName: string | null, participantId?: string): void {
    if (final) this.transcripts++;
    if (final && !this.sawTranscript) {
      this.sawTranscript = true;
      console.log("[rcai:bot] first transcript", JSON.stringify({ text: text.slice(0, 40), speakerName, participantId }));
    }
    const now = Date.now();
    const line: MeetingTranscriptLine = { id: ++this.lineId, speaker: speakerName ?? "?", text, final, at: now };
    this.init.handlers.onTranscript(line);
    this.policy.onTranscript({ text, final, speakerName, participantId }, now);
    if (final) {
      this.recent.push({ speaker: line.speaker, text });
      while (this.recent.length > 12) this.recent.shift();
    }
    // Entering ADDRESSED is handled by the transition listener, whatever caused it.
  }

  /**
   * Should the model see this frame?
   *
   * A face model reads a nod; a vision model reads the room, an expression the landmarks miss, what
   * someone is holding up to the camera. It is worth having and not worth spending on every frame:
   * Gemini takes at most 1 fps, every frame costs tokens, and a frame of a person who is not talking
   * to the character answers a question nobody asked. So: only the participant it is in a
   * conversation with, at most once a second, and while the character is speaking only when the face
   * actually changed — a reaction to what it is saying is the one thing worth interrupting for.
   */
  private maybeShowModel(participantId: string, jpegBase64: string, at: number, cue: VisualCue): void {
    const rt = this.runtime;
    if (!rt || !this.init.vision) return;
    if (this.policy.engagedWith?.participantId !== participantId) return;
    if (at - this.lastVisionAt < VISION_MIN_INTERVAL_MS) return;
    const speaking = this.policy.state === "RESPONDING";
    if (speaking && !(cue.nodded || cue.shookHead || cue.tilted || cue.smile > 0.6)) return;
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
  private async answer(): Promise<void> {
    const rt = this.runtime;
    const by = this.policy.addressedBy;
    if (!rt || !by) return;
    if (!this.outboundAllowed) {
      // muted / waiting room / reconnecting: we cannot be heard — do not generate speech into the void.
      this.policy.onAssistantDone(Date.now());
      return;
    }
    const context = this.recent.slice(0, -1).map((r) => `${r.speaker}: ${r.text}`).join("\n");
    const seen = this.visualContext();
    /**
     * Arrival is the one turn with nothing to answer. The greeting is the character's, not a fixed
     * line: it should sound like the persona and say the one thing the room needs to know — how to
     * get its attention — without a speech.
     */
    const greeting = by.detection.reason === JOINED_REASON;
    const asked = greeting
      ? `【入室】たった今この会議に参加しました。一言だけ挨拶してください：名前を名乗り、「${this.init.displayName}」と呼びかければ答えると伝える。自己紹介以上のことは話さない。`
      : by.text
        ? `【あなたへの質問】${by.speakerName ?? "参加者"}: ${by.text}`
        : `【言葉のない反応】${by.detection.reason}`;
    const prompt = greeting
      ? `${asked}\n\n短く（1〜2文で）。`
      : `${context ? `【会議の直近の発言】\n${context}\n\n` : ""}${seen ? `${seen}\n\n` : ""}${asked}\n\n短く（1〜2文で）答えてください。`;
    this.avatarRuntime?.handleEvent({ type: "assistant_thinking" });
    try {
      await rt.sendText(prompt, { hidden: true });
    } catch (err) {
      this.init.handlers.onError(err instanceof Error ? err.message : String(err), "PROVIDER");
      this.policy.onAssistantDone(Date.now());
    }
  }

  private onConversationEvent(e: ConversationEvent): void {
    const now = Date.now();
    this.avatarRuntime?.handleEvent(e);
    this.behavior?.handleEvent(e);
    this.init.handlers.onEvent?.(e);
    switch (e.type) {
      case "user_transcript":
        /**
         * The AI's recogniser is the only one on this path, so its transcripts are what the policy
         * hears. Shown as a meeting line too — otherwise the operator sees a character answering
         * something nobody can read.
         */
        if (!this.hasExternalTranscripts && e.final !== false && e.text.trim()) {
          this.onMeetingTranscript(e.text, true, this.lastSpeaker, this.lastSpeakerId);
        }
        break;
      case "assistant_speech_started":
        /**
         * A provider that answers on its own started talking without being asked. Stop it rather than
         * let it run: the audio is muted either way, and a model talking into a muted channel costs
         * tokens and leaves the character mid-sentence when it is finally spoken to.
         */
        if (!this.sanctioned) {
          this.cut("unsanctioned");
          break;
        }
        this.policy.markResponding(now);
        if (this.init.role === "bot") this.report("speaking", { state: this.policy.state });
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
          if (!this.init.attendeeAttach || this.init.outboundPath !== "page") this.session?.pushOutboundAudio(e.frame);
        }
        break;
      case "assistant_transcript":
        if (e.final !== false) this.init.handlers.onTranscript({ id: ++this.lineId, speaker: this.init.displayName, text: e.text, final: true, at: now, self: true });
        break;
      case "assistant_speech_ended":
        void this.session?.endOutboundUtterance?.();
        if (this.init.role === "bot" && this.sanctioned) this.report("spoke", { frames: this.spokeFrames });
        this.sanctioned = false;
        if (this.policy.state === "RESPONDING" || this.policy.state === "ADDRESSED") this.policy.onAssistantDone(now);
        break;
      case "interrupted":
        /**
         * Cut off mid-sentence. The audio has already stopped — that is the runtime's fast path and not
         * a decision made here. What matters to the conversation is that this was not a turn the
         * character completed: the floor belongs to whoever cut in, the conversation stays open, and
         * the consecutive-turn count must not be spent on an answer nobody heard.
         */
        void this.session?.endOutboundUtterance?.();
        if (this.init.role === "bot" && this.sanctioned) this.report("interrupted", { frames: this.spokeFrames });
        this.sanctioned = false;
        this.policy.onInterrupted(now);
        break;
      case "error":
        this.init.handlers.onError(e.error.message, "PROVIDER");
        break;
      default:
        break;
    }
  }

  /** Operator: mute the character (back to observing). */
  hush(): void {
    this.policy.reset(Date.now());
    this.cut("hush");
  }

  /** Stop whatever the character is saying, and tell the broker why (a bot's log is all we get from a room). */
  private cut(reason: string): void {
    if (this.init.role === "bot") this.report("cut", { reason, state: this.policy.state, sanctioned: this.sanctioned });
    void this.runtime?.interrupt();
  }

  status(): MeetingStatus {
    return this.session?.status() ?? this.meetingStatus ?? (this.init.role === "bot" ? "in_call" : "created");
  }

  get activation(): { sessionId: string; botId: string } | null {
    return this.activated;
  }

  async leave(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.policyTimer) clearInterval(this.policyTimer);
    this.stopFeed?.();
    this.behavior?.stop();
    await this.runtime?.stop().catch(() => {});
    await this.mic?.stop().catch(() => {});
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.drawLoop !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.drawLoop);
    this.drawLoop = null;
    this.visual?.stop();
    this.visual = null;
    this.cues.clear();
    await this.avatarRuntime?.dispose().catch(() => {});
    await this.speaker?.close().catch(() => {});
    await this.session?.leave().catch(() => {});
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
