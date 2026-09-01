import { EnergyVAD, MicCapture, SpeakerOutput, dbfs, rms, type PCMFrame } from "@rcai/audio-core";
import { ConversationRuntime, type ConversationEvent, type ProviderId } from "@rcai/conversation-core";
import { AvatarRuntime, loadCharacter, type AvatarProvider, type CharacterDefinition, type Emotion, type StateTransition } from "@rcai/avatar-core";
import { BehaviorEngine, RemoteSemanticPlanner } from "@rcai/behavior-engine";
import { createSessionConfig, type Persona } from "@rcai/persona-core";
import { ParticipationPolicy, type MeetingEvent, type MeetingSession, type MeetingStatus, type PolicyTransition, type Proactivity } from "@rcai/meeting-core";
import { createAvatarProvider, createConversationProvider, createMeetingConnector, plannerUrl, type CharacterEntry } from "../integrations/registry.js";
import { decide, type Availability, type Settings } from "../state/settings.js";

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
  /** Meeting vendor: "recall" (default) or "attendee". */
  meetingProvider?: "recall" | "attendee";
  /** Attendee voice-agent page: attach to the bot already carrying us instead of creating another. */
  attendeeAttach?: { botId: string; clientWsUrl: string };
  /** bot role: activation already performed by the screen (tokens are single-use — never activate twice). */
  botActivation?: { sessionId: string; botId: string };
  connectorMode?: "output_media" | "relay";
  stage: HTMLElement | null;
  handlers: MeetingHandlers;
  /** bot role only: transcript feed from the bot's own data websocket (injected for tests). */
  botTranscriptFeed?: (cb: (e: { text: string; final: boolean; speakerName: string | null }) => void) => () => void;
}

/**
 * Meeting participation (P0-1). Contract boundaries: MeetingConnector (vendor) ↔ ParticipationPolicy (pure) ↔
 * ConversationRuntime (AI) ↔ AvatarRuntime. The AI only hears the meeting while the policy allows it and is
 * handed the addressing utterance as text (provider-agnostic), so it answers what it was asked.
 */
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
  private forwarding = false;
  private policyTimer: ReturnType<typeof setInterval> | null = null;
  private decision: ReturnType<typeof decide>;
  private disposed = false;
  private muted = false;
  private meetingStatus: MeetingStatus | null = null;
  private activated: { sessionId: string; botId: string } | null = null;

  constructor(private readonly init: MeetingInit) {
    this.decision = decide(init.settings, init.availability);
    // Aliases matter in Japanese meetings: STT writes 「ゆい」, never "Yui".
    const names = [init.displayName, init.character.name, ...(init.character.aliases ?? [])].filter(Boolean);
    this.policy = new ParticipationPolicy({ names, proactivity: init.proactivity });
    this.policy.onTransition((t) => init.handlers.onPolicy(t));
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
      botPageQuery: { character: character.id, persona: persona.id, engine: this.decision.conversation, name: displayName, proactivity: this.init.proactivity, language: persona.language },
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
  private async startBotPage(): Promise<void> {
    // Gate 5: the page must prove it was loaded from a signed, unexpired, unused bot-page URL before doing anything.
    const { botToken, botBrokerUrl, botActivation, settings, handlers } = this.init;
    if (botActivation) this.activated = botActivation;
    else {
      if (!botToken) throw new Error("BOT_PAGE_TOKEN_REQUIRED: this page was opened without a signed session token");
      const { activateBotPage } = await import("@rcai/connector-recall");
      const act = await activateBotPage(botBrokerUrl ?? settings.brokerUrl, botToken);
      this.activated = { sessionId: act.sessionId, botId: act.botId };
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
      this.stopFeed = feed((e) => this.onMeetingTranscript(e.text, e.final, e.speakerName ?? null));
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
    if (stage) {
      const avatar = await createAvatarProvider(character.renderer, { container: stage, brokerUrl, privacyMode: settings.privacyMode });
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

    runtime.on((e) => this.onConversationEvent(e));

    if (!o.micFromMeeting) {
      // Bot page: getUserMedia is the meeting audio (Recall grants it without a prompt).
      const mic = new MicCapture({ context: speaker.context });
      this.mic = mic;
      const stream = await mic.start();
      mic.onFrame((frame) => this.onMeetingAudio(frame));
      runtime.attachMicStream(stream);
    }

    const provider = await createConversationProvider(this.decision.conversation, { brokerUrl, agentUrl, privacyMode: settings.privacyMode });
    const extra = `あなたはオンライン会議に参加している「${this.init.displayName}」です。会議の参加者に名前で呼ばれたときだけ、簡潔に（1〜2文で）答えます。呼ばれていない間は発言しません。`;
    const config = createSessionConfig({ persona, character: def, providerId: this.decision.conversation, privacyMode: settings.privacyMode, extra });
    // Meetings never auto-open: suppress the persona's opening line.
    config.providerOptions = { ...config.providerOptions, opening: undefined };
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
        this.onMeetingAudio(e.frame);
        break;
      case "transcript":
        this.onMeetingTranscript(e.text, e.final, e.speakerName ?? null);
        break;
      case "speech":
        this.policy.onSpeechActivity(e.active, now, e.participant.name);
        if (!this.forwarding) this.avatarRuntime?.handleEvent({ type: e.active ? "user_speech_started" : "user_speech_ended", at: now });
        break;
      case "error":
        this.init.handlers.onError(e.error.message, "MEETING");
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
      void this.runtime?.interrupt();
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
      void this.runtime?.interrupt();
    }
  }

  /** Operator / bot page: the host muted or unmuted the character. */
  reportHostMute(muted: boolean): void {
    const s = this.session as (MeetingSession & { setAudioMuted?(m: boolean): void }) | null;
    if (s?.setAudioMuted) s.setAudioMuted(muted);
    else this.setMuted(muted);
  }

  /** Meeting audio (48 kHz). Gated: the AI only hears it while the policy allows. */
  onMeetingAudio(frame: PCMFrame): void {
    const level = dbfs(rms(frame.data));
    this.behavior?.reportUserAudio(Math.max(0, Math.min(1, (level + 50) / 35)), frame.timestamp);
    const allowed = this.policy.state === "ADDRESSED" || this.policy.state === "RESPONDING";
    if (allowed !== this.forwarding) this.forwarding = allowed;
    if (allowed) {
      this.runtime?.pushMicFrame(frame);
      return;
    }
    // Observing: keep the avatar alive with local VAD → LISTENING micro-motion, but never feed the AI.
    for (const ev of this.vad.process(frame)) {
      this.policy.onSpeechActivity(ev.type === "speech_start", frame.timestamp);
      this.avatarRuntime?.handleEvent({ type: ev.type === "speech_start" ? "user_speech_started" : "user_speech_ended", at: frame.timestamp });
    }
  }

  onMeetingTranscript(text: string, final: boolean, speakerName: string | null): void {
    const now = Date.now();
    const line: MeetingTranscriptLine = { id: ++this.lineId, speaker: speakerName ?? "?", text, final, at: now };
    this.init.handlers.onTranscript(line);
    const before = this.policy.state;
    this.policy.onTranscript({ text, final, speakerName }, now);
    if (final) {
      this.recent.push({ speaker: line.speaker, text });
      while (this.recent.length > 12) this.recent.shift();
    }
    if (before !== "ADDRESSED" && this.policy.state === "ADDRESSED") void this.answer();
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
    const prompt = `${context ? `【会議の直近の発言】\n${context}\n\n` : ""}【あなたへの質問】${by.speakerName ?? "参加者"}: ${by.text}\n\n短く（1〜2文で）答えてください。`;
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
      case "assistant_speech_started":
        this.policy.markResponding(now);
        break;
      case "assistant_audio":
        if (this.outboundAllowed) this.session?.pushOutboundAudio(e.frame);
        break;
      case "assistant_transcript":
        if (e.final !== false) this.init.handlers.onTranscript({ id: ++this.lineId, speaker: this.init.displayName, text: e.text, final: true, at: now, self: true });
        break;
      case "assistant_speech_ended":
      case "interrupted":
        void this.session?.endOutboundUtterance?.();
        if (this.policy.state === "RESPONDING" || this.policy.state === "ADDRESSED") this.policy.onAssistantDone(now);
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
