import { EnergyVAD, MicCapture, SpeakerOutput, dbfs, rms, type PCMFrame } from "@rcai/audio-core";
import { ConversationRuntime, type ConversationEvent, type ProviderId } from "@rcai/conversation-core";
import { AvatarRuntime, loadCharacter, type AvatarProvider, type CharacterDefinition, type Emotion, type StateTransition } from "@rcai/avatar-core";
import { BehaviorEngine, RemoteSemanticPlanner } from "@rcai/behavior-engine";
import { createSessionConfig, type Persona } from "@rcai/persona-core";
import { ParticipationPolicy, type MeetingEvent, type MeetingSession, type MeetingStatus, type PolicyTransition, type Proactivity } from "@rcai/meeting-core";
import type { VisualCue } from "@rcai/visual-core";
import { VisualPerceptionService } from "./VisualPerceptionService.js";
import { createAvatarProvider, createConversationProvider, createMeetingConnector, plannerUrl, type CharacterEntry } from "../integrations/registry.js";
import { chosenVoice, decide, type Availability, type Settings } from "../state/settings.js";

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
  /**
   * Voice chosen by the operator. The bot page has its own empty settings storage, so the choice
   * only survives the trip when it is carried explicitly (bot role) rather than read from settings.
   */
  voiceId?: string;
  /** bot role: activation already performed by the screen (tokens are single-use — never activate twice). */
  botActivation?: { sessionId: string; botId: string };
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

  /** Never throws: an avatar that will not load is reported and the meeting continues with the voice. */
  private async createAvatar(character: CharacterEntry, stage: HTMLElement, brokerUrl: string, privacyMode: Settings["privacyMode"]): Promise<AvatarProvider | null> {
    try {
      return await createAvatarProvider(character.renderer, { container: stage, brokerUrl, privacyMode });
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
  private activated: { sessionId: string; botId: string } | null = null;

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
      if (t.to === "ADDRESSED") void this.answer();
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
      botPageQuery: { character: character.id, persona: persona.id, engine: this.decision.conversation, name: displayName, proactivity: this.init.proactivity, language: persona.language, ...(this.voiceId() ? { voice: this.voiceId()! } : {}) },
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
        this.onMeetingTranscript(e.text, e.final, e.speakerName ?? null, e.participantId);
        break;
      case "speech":
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

  /**
   * `participantId` is what keeps a conversation attached to one person: the engagement layer answers
   * follow-ups from whoever called the character, and only from them. A display name is the fallback
   * when the vendor gives no id — two people called 「田中」 would share one conversation, which is
   * still better than every turn needing the name again.
   */
  onMeetingTranscript(text: string, final: boolean, speakerName: string | null, participantId?: string): void {
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

  /** Loads the face model in the background; a failure is named, never silent, and never fatal. */
  private async startVisual(): Promise<void> {
    if (this.visual) return;
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
    const asked = by.text
      ? `【あなたへの質問】${by.speakerName ?? "参加者"}: ${by.text}`
      : `【言葉のない反応】${by.detection.reason}`;
    const prompt = `${context ? `【会議の直近の発言】\n${context}\n\n` : ""}${seen ? `${seen}\n\n` : ""}${asked}\n\n短く（1〜2文で）答えてください。`;
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
