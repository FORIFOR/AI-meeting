import { MeetingUsageTracker, type MeetingUsageReceipt } from "../billing/meetingUsage.js";
import { MeetingUsageSummary } from "../components/MeetingUsageSummary.js";
import { LiveCostSummary } from "../components/LiveCostSummary.js";
import { ZoomConnection } from "../components/ZoomConnection.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { VOICE_OPTIONS, type Persona } from "@rcai/persona-core";
import { purposeLabel } from "../components/choiceLabels.js";
import { blockedReason } from "../components/characters.js";
import type { BrokerHealth } from "../api/health.js";
import { CreditBalance } from "../components/CreditBalance.js";
import { PRODUCTS } from "./Home.js";
import { MEETING_PERSONA_ID, defaultProactivityFor, type MeetingStatus, type ParticipationState, type Proactivity } from "@rcai/meeting-core";
import type { AvatarState } from "@rcai/avatar-core";
import type { CharacterEntry } from "../integrations/registry.js";
import { chosenVoice, decide, settingsForBotPage, type Availability, type Settings } from "../state/settings.js";
import { MeetingSessionController, type MeetingTranscriptLine } from "../session/MeetingSessionController.js";
import { pillFor } from "../session/pill.js";
import { meetingPlatform } from "@rcai/conversation-core";

export interface MeetingProps {
  settings: Settings;
  availability: Availability | null;
  personas: Persona[];
  characters: CharacterEntry[];
  /** Present when this page runs inside the Recall bot (Output Media). */
  botParams?: { token: string; brokerUrl?: string; botId?: string; characterId?: string; personaId?: string; displayName?: string; proactivity?: string } | null;
  broker?: BrokerHealth | null;
  brokerMeeting?: { attendee?: boolean; recall: boolean; recallPublicUrl: boolean; recallBotPageUrl: boolean } | null;
  onBack: () => void;
}

const STATUS_JA: Record<MeetingStatus, string> = {
  created: "作成済み", joining: "参加中…", waiting_room: "待機室（承認待ち）", in_call_not_recording: "入室（音声待ち）", in_call: "会議に参加中", reconnecting: "再接続中…", leaving: "退出中", left: "退出しました", denied: "入室が拒否されました", removed: "ホストに退出させられました", ended: "会議が終了しました", failed: "失敗",
};
const POLICY_JA: Record<ParticipationState, string> = { OBSERVING: "見守り中", LISTENING: "聞いています", ADDRESSED: "呼ばれました", RESPONDING: "返答中" };

/** Keep pasted links usable when they include a trailing newline or surrounding spaces. */
export function normalizeMeetingUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}

/** The operator must wait for the broker probe instead of falling back to the unavailable Recall connector. */
export function resolveMeetingProvider(meeting: MeetingProps["brokerMeeting"]): "attendee" | "recall" | null {
  if (!meeting) return null;
  if (meeting.attendee) return "attendee";
  if (meeting.recall) return "recall";
  return null;
}

function meetingUrlHint(value: string): string | null {
  const normalized = normalizeMeetingUrlInput(value);
  if (!normalized) return null;
  const platform = meetingPlatform(normalized);
  return platform ? null : "Google Meet または Zoom の招待リンクを入力してください。URLの前後に説明文は入れず、そのまま貼り付けてください。";
}

function meetingErrorMessage(value: string): string {
  const code = value.split(":", 1)[0] ?? value;
  const messages: Record<string, string> = {
    PLATFORM_NOT_RELEASED: "Google Meet または Zoom の招待リンクを確認してください。対応していないURLです。",
    DUPLICATE_JOIN: "この会議にはすでに参加しています。先に退出してから、もう一度お試しください。",
    BLOCKED_BY_ATTENDEE_KEY: "会議サービスの接続が準備中です。少し待ってからもう一度お試しください。",
    BLOCKED_BY_ATTENDEE_CREDIT: "会議サービスの残高が不足しているため、参加できません。",
    BLOCKED_BY_RECALL_KEY: "会議サービスの接続が準備中です。少し待ってからもう一度お試しください。",
    BLOCKED_BY_RECALL_PUBLIC_URL: "会議サービスの公開接続が準備中です。管理者にお問い合わせください。",
  };
  return messages[code] ?? value;
}

/**
 * Attendee may capture the bot page before a realtime renderer has mounted. Show the selected
 * character's real preview artwork immediately so Meet never receives a black or placeholder
 * character tile. The realtime renderer remains mounted above it for the audio/lip-sync path.
 */
function BotAvatarFallback({ name, characterId }: { name: string; characterId?: string }) {
  const previewByCharacter: Record<string, string> = {
    yui: "/avatar-fallbacks/yui.png",
    haru: "/avatar-fallbacks/haru.png",
    reina: "/avatar-fallbacks/reina.png",
  };
  const src = characterId ? previewByCharacter[characterId] : previewByCharacter.yui;
  return (
    <div className="stage__fallback-portrait" aria-hidden="true">
      {src ? <div className="stage__fallback-image" style={{ backgroundImage: `url(${src})` }} /> : <div className="stage__fallback-neutral"><span aria-hidden="true">AI</span></div>}
      <span>{name} · AIミーティング</span>
    </div>
  );
}

/** P0-1: join a Google Meet / Zoom as the character. Operator view + bot-page view share one controller. */
export function Meeting(p: MeetingProps) {
  const isBot = Boolean(p.botParams);
  const usage = useRef(new MeetingUsageTracker());
  const [usageReceipt, setUsageReceipt] = useState<MeetingUsageReceipt | null>(null);
  const [aiUsage, setAiUsage] = useState<Record<string, number> | null>(null);
  const [observeWithCaptions, setObserveWithCaptions] = useState(false);
  const [url, setUrl] = useState(() => { try { const saved = sessionStorage.getItem("rcai.zoom.meeting") ?? ""; sessionStorage.removeItem("rcai.zoom.meeting"); return saved; } catch { return ""; } });
  const [name, setName] = useState("");
  const [characterId, setCharacterId] = useState(p.settings.characterId);
  const [voices, setVoices] = useState<Record<string, string>>({});
  const [personaId, setPersonaId] = useState("");
  /**
   * Talking to the character one to one is the ordinary case, and there waiting to be called by name
   * is a summons rather than a conversation: the default opens up and only a meeting keeps
   * `addressed_only` (see defaultProactivityFor). The operator can still change it, and a bot page
   * carries its own in the URL.
   */
  const [proactivity, setProactivity] = useState<Proactivity | null>(null);
  /**
   * "cues" reads the webcam in this page only — nods, expressions, gaze — and nothing leaves it.
   * "model" also sends frames to the conversational provider, which is a different privacy decision
   * and is why it is not the default.
   */
  const [vision, setVision] = useState<"cues" | "model" | "off">("cues");
  const [mode, setMode] = useState<"output_media" | "relay">("output_media");
  const [status, setStatus] = useState<MeetingStatus | null>(null);
  const [timeline, setTimeline] = useState<{ at: number; text: string }[]>([]);
  const [policy, setPolicy] = useState<ParticipationState>("OBSERVING");
  const [avatarState, setAvatarState] = useState<AvatarState>("IDLE");
  const [muted, setMuted] = useState(false);
  const [activation, setActivation] = useState<{ sessionId: string; botId: string; clientToken?: string } | null>(null);
  /** Guards the single-use activation against StrictMode's double effect invocation. */
  const activating = useRef(false);
  /** Bot page: render config returned by the broker after the single-use token was accepted (never from the URL). */
  const [botConfig, setBotConfig] = useState<{ characterId?: string; personaId?: string; displayName?: string; proactivity?: string; engine?: string; provider?: string; voice?: string; vision?: string; outbound?: string; framing?: string; fps?: string; observer?: string } | null>(null);
  /** Public origins the broker hands the bot page at activation (loopback is blocked inside the bot). */
  const [botOrigins, setBotOrigins] = useState<{ brokerUrl?: string; agentUrl?: string }>({});
  /**
   * Broker relay socket for this bot — the second transcript source (see botTranscriptFeed). Keep a ref
   * for callbacks that run after render, and mirror it in state below so the start effect can gate on it.
   */
  const relayWsUrl = useRef<string | undefined>(undefined);
  /**
   * The bot page must not start until the activation response has been rendered with its client
   * socket URL. Keeping this in state gives the start effect a dependable readiness edge instead
   * of relying on a ref update that React cannot observe.
   */
  const [botRelayWsUrl, setBotRelayWsUrl] = useState<string | null>(null);
  /**
   * What the bot page can actually reach. The operator's health poll runs against loopback URLs the bot
   * process blocks, so inside the bot every provider reads "unavailable" and routing falls back to a cloud
   * engine that has no key — the character then renders but never speaks (BLOCKED_BY_OPENAI_KEY). Probing
   * the public origins gives routing the truth: local is up, the cloud providers are not configured.
   */
  const [botAvailability, setBotAvailability] = useState<Availability | null>(null);
  const [lines, setLines] = useState<MeetingTranscriptLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [visualNotice, setVisualNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ctrl = useRef<MeetingSessionController | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const t0 = useRef(Date.now());

  const character = useMemo(() => p.characters.find((c) => c.id === (isBot ? botConfig?.characterId : characterId)) ?? p.characters[0], [p.characters, characterId, isBot, botConfig]);
  const persona = useMemo(() => p.personas.find((x) => x.id === (isBot ? botConfig?.personaId : personaId)) ?? p.personas.find((x) => x.id === MEETING_PERSONA_ID) ?? p.personas.find((x) => x.mode === "free_talk") ?? p.personas[0], [p.personas, personaId, isBot, botConfig]);
  const displayName = (isBot ? botConfig?.displayName : name) || character?.name || "Yui";
  const selectedProvider = decide(p.settings, p.availability ?? undefined).conversation;
  const voiceKey = `${character?.id}:${selectedProvider}`;
  const selectedVoice = voices[voiceKey] ?? chosenVoice(p.settings, character?.id, selectedProvider) ?? "";
  const voiceOptions = VOICE_OPTIONS[selectedProvider];
  const strict = p.settings.privacyMode === "strict_local";
  const meetingProvider = isBot ? (botConfig?.provider === "attendee" ? "attendee" : botConfig?.provider === "recall" ? "recall" : null) : resolveMeetingProvider(p.brokerMeeting);
  // Attendee carries the call over the relay, so the operator page can render the same
  // character locally. Keeping the stage hidden in the default output_media mode made
  // the meeting audible while the Yui avatar appeared to be missing.
  const meetingMode = !isBot && meetingProvider === "attendee" ? "relay" : mode;
  const connectorPending = !isBot && p.brokerMeeting === null;
  const blocked = strict
    ? "BLOCKED_BY_STRICT_LOCAL"
    : connectorPending
      ? null
      : !meetingProvider
        ? "BLOCKED_BY_RECALL_KEY"
        : p.brokerMeeting && !p.brokerMeeting.recallPublicUrl
          ? "BLOCKED_BY_RECALL_PUBLIC_URL"
          : null;
  const urlError = meetingUrlHint(url);

  const note = (text: string) => setTimeline((t) => [...t.slice(-60), { at: Date.now() - t0.current, text }]);

  const start = async (role: "operator" | "bot") => {
    if (!character || !persona) return;
    const meetingUrl = normalizeMeetingUrlInput(url);
    if (!meetingUrl) {
      setError("会議URLを入力してください。");
      return;
    }
    if (!isBot && !meetingProvider) {
      setError(connectorPending ? "会議サービスを確認しています。少し待ってから、もう一度参加してください。" : "会議サービスの接続が利用できません。管理者にお問い合わせください。");
      return;
    }
    if (!meetingPlatform(meetingUrl)) {
      setError(meetingUrlHint(meetingUrl) ?? "Google Meet または Zoom の招待リンクを入力してください。");
      return;
    }
    setBusy(true);
    setError(null);
    setVisualNotice(null);
    // Mark the session as starting before the provider responds. This keeps the operator view from
    // showing the idle URL form while the meeting page is already being opened in Attendee.
    setStatus("joining");
    const attemptUsage = new MeetingUsageTracker();
    usage.current = attemptUsage;
    setAiUsage(null);
    setUsageReceipt(null);
    try {
      /**
       * The operator's engine travels in the bot-page URL, and until now the page stored it and then
       * routed by its own empty settings — "auto", which prefers a cloud engine. A bot page whose
       * OpenAI account has no credit then renders the character and never speaks (429, in-call).
       * The choice that was made when the bot was created is the one that must be used.
       */
      const settings = isBot ? settingsForBotPage(p.settings, botConfig?.engine) : p.settings;
      const c = new MeetingSessionController({
        settings,
        availability: (isBot ? botAvailability : p.availability) ?? { openai: false, google: false, local: false },
        persona,
        character,
        meetingUrl,
        displayName,
        proactivity: (isBot ? (botConfig?.proactivity as Proactivity | undefined) : undefined) ?? proactivity ?? defaultProactivityFor({ personaId: persona?.id, mode: persona?.mode }),
        role,
        botToken: isBot ? p.botParams?.token : undefined,
        botBrokerUrl: isBot ? (botOrigins.brokerUrl ?? p.botParams?.brokerUrl) : undefined,
        botAgentUrl: isBot ? botOrigins.agentUrl : undefined,
        botActivation: isBot && activation ? activation : undefined,
        voiceId: isBot ? botConfig?.voice : selectedVoice || undefined,
        outboundPath: (isBot ? botConfig?.outbound : undefined) === "page" ? "page" : "socket",
        framing: isBot && botConfig?.framing === "default" ? "default" : "meeting",
        avatarFps: isBot && Number(botConfig?.fps) > 0 ? Number(botConfig?.fps) : undefined,
        vision: (isBot ? botConfig?.vision : vision) === "model",
        visualCues: (isBot ? botConfig?.vision : vision) !== "off",
        // Which vendor is carrying this call. The bot page learns it from its own URL; without it the
        // page cannot know that Attendee sends no transcripts and must listen for itself.
        meetingProvider: meetingProvider === "attendee" ? "attendee" : meetingProvider === "recall" ? "recall" : undefined,
        connectorMode: meetingMode,
        stage: role === "bot" || meetingMode === "relay" ? stage.current : null,
        // Attendee runs this page as its voice agent: meeting audio arrives on the broker relay rather
        // than through getUserMedia, and the page's own speaker is what Attendee streams back.
        observer: isBot ? (botConfig?.observer === "captions" ? "captions" : undefined) : persona?.id === MEETING_PERSONA_ID && observeWithCaptions && p.brokerMeeting?.attendee ? "captions" : "live",
        attendeeAttach: botConfig?.provider === "attendee" && botRelayWsUrl ? { botId: activation?.botId ?? "", clientWsUrl: botRelayWsUrl } : undefined,
        botTranscriptFeed: role === "bot" ? (cb) => {
          // Two sources for the same transcripts: the bot's own socket, and the broker relay Recall also
          // delivers to. Either alone is a single point of failure for a character that only answers when
          // it is addressed — and the in-bot socket exists only inside a bot, so on its own the path can
          // never be exercised outside a real call.
          const stops: (() => void)[] = [];
          void import("@rcai/connector-recall").then((m) => {
            const once = m.dedupeTranscript(cb);
            stops.push(m.connectBotTranscript(once));
            if (relayWsUrl.current) stops.push(m.connectRelayTranscript(relayWsUrl.current, once));
          });
          return () => { for (const s of stops) s(); };
        } : undefined,
        handlers: {
          onUsage: counters => {
            if (usage.current !== attemptUsage) return;
            setAiUsage(previous => Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, Math.max(previous?.[key] ?? 0, value)])));
          },
          onStatus: (s, d) => {
            if (usage.current !== attemptUsage) return;
            setStatus(s); note(`${STATUS_JA[s]}${d ? ` · ${d}` : ""}`);
            if (!isBot && p.brokerMeeting?.attendee) {
              if (d === "bot created") attemptUsage.created(Date.now());
              const receipt = attemptUsage.status(s, Date.now());
              if (receipt) setUsageReceipt(receipt);
            }
          },
          onTranscript: (line) => setLines((ls) => {
            const same = ls.findIndex((x) => x.id === line.id);
            if (same >= 0) return ls.map((x, k) => (k === same ? line : x)); // a revised reading of a line already shown
            const i = ls.findIndex((x) => !x.final && x.speaker === line.speaker && !x.self);
            if (!line.final && i >= 0) return ls.map((x, k) => (k === i ? line : x));
            return [...ls.filter((x) => x.final || x.speaker !== line.speaker), line].slice(-80);
          }),
          onPolicy: (t) => { setPolicy(t.to); note(`${POLICY_JA[t.from]} → ${POLICY_JA[t.to]} (${t.reason})`); },
          onAvatarState: (t) => setAvatarState(t.to),
          onMuted: (m) => { setMuted(m); note(m ? "ホストにミュートされました（発話を保留）" : "ミュート解除"); },
          onActivated: (a) => { setActivation(a); note(`bot page activated · session ${a.sessionId.slice(0, 8)} · bot ${a.botId}`); },
          onError: (m, code) => {
            const line = `${code ? `${code}: ` : ""}${m}`;
            // Visual cues are an optional enhancement. Do not put their failure in the fatal
            // error state: bot-page activation and the voice session must continue.
            if (code === "VISUAL") {
              setVisualNotice("表情の読み取りは現在利用できません。会議と音声はそのまま続けられます。");
              note("visual cues unavailable");
              if (isBot) console.warn("[rcai:bot]", line);
              return;
            }
            setError(line);
            note(`error ${m}`);
            /**
             * A bot page has no operator looking at it — it is a browser inside a meeting vendor. An
             * error that only reaches React state is an error nobody will ever read, which is how a
             * character comes back from a call having silently done nothing.
             */
            if (isBot) console.error("[rcai:bot]", line);
          },
        },
      });
      ctrl.current = c;
      if (isBot) console.log("[rcai:bot] starting", JSON.stringify({ engine: settings.engine, character: character?.id, persona: persona?.id, provider: botConfig?.provider, vision, proactivity: (isBot ? botConfig?.proactivity : proactivity) ?? proactivity, relay: !!botRelayWsUrl, agent: botOrigins.agentUrl ?? null }));
      await c.start();
      if (isBot) console.log("[rcai:bot] started", c.providerId);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const message = meetingErrorMessage(raw);
      setStatus("failed");
      setError(message);
      note(`error ${message}`);
    } finally {
      setBusy(false);
    }
  };

  // Bot page step 1: activate the signed single-use token with the broker; the render config comes back server-side.
  // The token is single-use, so this must run EXACTLY once per page load. A ref guard — not the effect body —
  // enforces that: React StrictMode invokes the effect twice in development, and a second activation of the same
  // nonce is (correctly) refused as `replayed`, which would strand the bot page on an error it can never leave.
  // For the same reason the in-flight result is applied even after cleanup: discarding it would lose the one
  // activation the broker granted.
  useEffect(() => {
    if (!isBot || activation || error || activating.current) return;
    const token = p.botParams?.token ?? "";
    if (!token) { setError("BOT_PAGE_TOKEN_REQUIRED"); return; }
    activating.current = true;
    void (async () => {
      try {
        const m = await import("@rcai/connector-recall");
        const act = await m.activateBotPage(p.botParams?.brokerUrl ?? p.settings.brokerUrl, token);
        setBotConfig({ characterId: act.botPageQuery.character, personaId: act.botPageQuery.persona, displayName: act.botPageQuery.name, proactivity: act.botPageQuery.proactivity, engine: act.botPageQuery.engine, provider: act.botPageQuery.provider, voice: act.botPageQuery.voice, vision: act.botPageQuery.vision, outbound: act.botPageQuery.outbound, framing: act.botPageQuery.framing, fps: act.botPageQuery.fps, observer: act.botPageQuery.observer });
        const origins = { brokerUrl: act.brokerUrl ?? undefined, agentUrl: act.agentUrl ?? undefined };
        setBotOrigins(origins);
        relayWsUrl.current = act.clientWsUrl;
        setBotRelayWsUrl(act.clientWsUrl);
        if (origins.brokerUrl && origins.agentUrl) {
          const { probe, shouldProbeLocalAgent } = await import("../api/health.js");
          const engine = (act.botPageQuery.engine as typeof p.settings.engine | undefined) ?? p.settings.engine;
          const h = await probe(origins.brokerUrl, origins.agentUrl, p.settings.privacyMode, { agent: shouldProbeLocalAgent({ ...p.settings, engine }) }).catch(() => null);
          if (h) { setBotAvailability(h.availability); note(`engines · local ${h.availability.local} · openai ${h.availability.openai} · google ${h.availability.google}`); }
        }
        setActivation({ sessionId: act.sessionId, botId: act.botId, clientToken: act.clientToken });
        note(`activated · session ${act.sessionId.slice(0, 8)} · bot ${act.botId} · activation #${act.activations}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg); // BOT_PAGE_ACTIVATION_401:expired / revoked → never start
        note(`activation refused: ${msg}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBot]);

  // Bot page step 2: start once activated and content is loaded (the bot grants mic access without a gesture).
  useEffect(() => {
    /**
     * Activation and its server-side render config arrive together, but React may commit the
     * activation state before the config state. Starting in that intermediate render loses the
     * Attendee provider/relay fields, so the page falls back to getUserMedia and never connects
     * the bot's audio socket (a black, silent meeting tile). Wait until the signed config is present
     * before creating the controller; the config is also a dependency so the effect retries once it
     * has been committed.
     */
    const attendeeReady = !isBot || botConfig?.provider !== "attendee" || !!botRelayWsUrl;
    if (isBot && activation && botConfig && attendeeReady && !ctrl.current && character && persona && p.characters.length && p.personas.length) void start("bot");
    return () => { void ctrl.current?.leave().catch(() => {}); ctrl.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBot, activation, botConfig, botRelayWsUrl, character?.id, persona?.id, p.characters.length, p.personas.length]);

  const leave = async () => {
    setBusy(true);
    try {
      await ctrl.current?.leave();
      const receipt = usage.current.finish(Date.now());
      if (receipt) setUsageReceipt(receipt);
      ctrl.current = null;
      setStatus("left");
    } catch (e) {
      setError(e instanceof Error ? e.message : "退出を確認できませんでした。もう一度退出してください。");
    } finally { setBusy(false); }
  };

  const pill = pillFor(avatarState, false);
  const terminal = status === "left" || status === "failed" || status === "denied" || status === "removed" || status === "ended";
  const joined = status !== null && !terminal;
  const showPolicy = status === "in_call" || status === "in_call_not_recording" || status === "waiting_room" || status === "reconnecting";
  /** Keep the mount in the DOM for the controller, but never show an empty black tile before/after a call. */
  const showRelayStage = joined && meetingMode === "relay";

  if (isBot) {
    return (
      <div className="session session--bot">
        <div className="stage" ref={stage}>
          <BotAvatarFallback name={displayName} characterId={character?.id} />
          <div className="stage__fallback stage__fallback--bot" aria-hidden="true"><strong>{displayName}</strong><span>音声で参加中</span></div>
          <div className={`pill pill--${pill.key}`}><span className="pill__dot" /> {muted ? "ミュート中" : POLICY_JA[policy]} <span style={{ opacity: 0.5 }}>{pill.en}</span></div>
          {!activation && !error && <div className="err" style={{ position: "absolute", bottom: 12, left: 12, opacity: 0.6 }}>接続中…</div>}
          {error && <div className="err" style={{ position: "absolute", bottom: 12, left: 12 }}>{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="page meeting">
      <div>
        <div>
          <div className="page__eyebrow">同席</div>
          <h1 className="page__title">会議に参加</h1>
          <p className="page__lede">Google Meet / Zoom の URL を入れると、{displayName} が参加者として入室します。相手・用途・声を選んで、参加してください。</p>
        </div>
        {connectorPending && <p className="hint" role="status">会議サービスを確認しています…</p>}
        {blocked && <p className="err">{strict ? "会議に参加するには、設定でクラウドの利用を有効にしてください。" : "会議への接続を準備できていません。管理者にお問い合わせください。"}</p>}
        {visualNotice && <p className="hint" role="status">{visualNotice}</p>}
        {usageReceipt && terminal && <MeetingUsageSummary receipt={usageReceipt} aiUsage={aiUsage} />}
        <div className={`field meeting__url-field${joined ? " meeting__url-field--active" : ""}`}>
          {joined ? (
            <div className="meeting__active-status" role="status" aria-live="polite">
              <span className="meeting__active-dot" aria-hidden="true" />
              <span><strong>会議に参加中</strong><small>{(proactivity ?? defaultProactivityFor({ personaId: persona?.id, mode: persona?.mode })) === "addressed_only" ? `「${displayName}、聞こえますか？」と会議で呼びかけてください` : `${displayName} が会議を聞いています`}</small></span>
            </div>
          ) : (
            <>
              <label htmlFor="meeting-url">最初に、会議のURLを貼り付けてください</label>
              <input id="meeting-url" className="input" type="url" inputMode="url" autoComplete="url" spellCheck={false} aria-describedby="meeting-url-hint" placeholder="https://meet.google.com/xxx-xxxx-xxx" value={url} onChange={(e) => setUrl(e.target.value)} disabled={joined} />
              <p id="meeting-url-hint" className={urlError ? "err" : "hint"}>{urlError ?? "Google Meet・Zoomの招待リンクに対応しています。前後に空白があっても自動で整えます。"}</p>
            </>
          )}
        </div>
        {aiUsage && !terminal && <LiveCostSummary counters={aiUsage} />}
        <details><summary>残りのクレジットを確認</summary><CreditBalance enabled={!strict} /></details>
        <div className="field"><label htmlFor="meeting-character">1. 話す相手</label>
          <select id="meeting-character" className="select" value={character?.id ?? ""} onChange={e => setCharacterId(e.target.value)} disabled={joined}>
            {p.characters.map(c => <option key={c.id} value={c.id} disabled={!!blockedReason(c, p.broker ?? null, strict)}>{c.name}{blockedReason(c, p.broker ?? null, strict) ? "（準備中）" : ""}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="meeting-purpose">2. やりたいこと</label>
          <select id="meeting-purpose" className="select" value={persona?.id ?? ""} onChange={(e) => setPersonaId(e.target.value)} disabled={joined}>
            {p.personas.map((x) => <option key={x.id} value={x.id}>{PRODUCTS.find(p => p.mode === x.mode)?.name ?? "会議"} · {purposeLabel(x.name)}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="meeting-voice">3. 声を選ぶ</label>
          <select id="meeting-voice" className="select" value={selectedVoice} onChange={e => setVoices(v => ({ ...v, [voiceKey]: e.target.value }))} disabled={joined}>
            <option value="">おまかせ（相手に合う声）</option>
            {voiceOptions.map(v => <option key={v.id} value={v.id}>{v.note}（{v.label}）</option>)}
          </select>
        </div>
        <ZoomConnection base={p.settings.brokerUrl} meetingUrl={url} disabled={busy || joined} />
        {p.brokerMeeting?.attendee && persona?.id === MEETING_PERSONA_ID && <div className="field">
          <label><input type="checkbox" checked={observeWithCaptions} onChange={e => setObserveWithCaptions(e.target.checked)} disabled={joined} /> 字幕で見守り、呼ばれたときだけAIと会話する（省コスト・試験提供）</label>
          <p className="hint">会議の字幕が必要です。会話品質を検証中です。呼びかけが届かない・会話が途切れる場合は、退出してこの設定を外してください。</p>
        </div>}
        <details><summary>話し方・カメラなどの設定</summary>
        <div className="field"><label>表示名（変更したいときだけ）</label><input className="input" value={name} placeholder={character?.name ?? "Yui"} onChange={(e) => setName(e.target.value)} disabled={joined} /></div>
        <div className="field"><label>発言のしかた</label>
          <select className="select" value={proactivity ?? defaultProactivityFor({ personaId: persona?.id, mode: persona?.mode })} onChange={(e) => setProactivity(e.target.value as Proactivity)} disabled={joined}>
            <option value="addressed_only">名前で呼ばれたときだけ（会議向け）</option>
            <option value="invited">「誰か意見ある？」にも答える</option>
            <option value="active">未回答の質問にも自発的に答える</option>
            <option value="open">呼ばれなくても会話に入る（1対1の既定）</option>
          </select>
        </div>
        <div className="field">
          <label>カメラを見る</label>
          <select className="select" value={vision} onChange={(e) => setVision(e.target.value as "cues" | "model" | "off")} disabled={joined}>
            <option value="cues">うなずきや表情を読む</option>
            <option value="model">映像もAIに見せる（トークン消費・映像が送信されます）</option>
            <option value="off">見ない</option>
          </select>
        </div>
        <div hidden={!!p.brokerMeeting?.attendee} className="field"><label>接続方式</label>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} disabled={joined}>
            <option value="output_media">output_media — bot がこのアプリを表示・発話（推奨、映像あり）</option>
            <option value="relay">relay — このブラウザで会話（音声出力はMP3クリップ）</option>
          </select>
        </div>
        </details>
        <div className="actions">
          <button type="button" className="btn btn--ghost" onClick={p.onBack} disabled={busy}>← 戻る</button>
          {!joined ? (
            <button type="button" className="btn btn--primary btn--lg" disabled={busy || !normalizeMeetingUrlInput(url) || !!urlError || !!blocked || connectorPending || !meetingProvider || !character} onClick={() => void start("operator")}>参加する</button>
          ) : (
            <>
              <button type="button" className="btn btn--ghost" onClick={() => ctrl.current?.hush()}>黙らせる</button>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void leave()}>退出する</button>
            </>
          )}
        </div>
        {error && <p className="err" role="alert">{error}</p>}
      </div>
      <div className="meeting__side">
        <h3>状態 <small>{status ? STATUS_JA[status] : "未参加"}{muted ? " · ミュート中" : ""}{showPolicy ? ` · ${POLICY_JA[policy]}` : ""}{ctrl.current?.botId ? ` · ${ctrl.current.botId}` : ""}</small></h3>
        <div className="meeting__stage-wrap">
          <div className="stage stage--mini" ref={stage} style={{ display: meetingMode === "relay" ? "block" : "none", visibility: showRelayStage ? "visible" : "hidden" }} aria-hidden={!showRelayStage}>
            <div className="stage__fallback" aria-hidden="true"><strong>{displayName}</strong><span>参加中はここに表示されます</span></div>
          </div>
          {!showRelayStage && <div className="meeting__stage-empty" role="status">参加すると、{displayName} がここに表示されます</div>}
        </div>
        <ul className="timeline">{timeline.map((t, i) => <li key={i}><span className="mono">{(t.at / 1000).toFixed(1)}s</span> {t.text}</li>)}</ul>
        <h3>会議の文字起こし</h3>
        <div className="captions captions--list">
          {lines.map((l) => (
            <div key={l.id} className={`caption ${l.self ? "caption--assistant" : "caption--user"} ${l.final ? "" : "caption--partial"}`}>
              <span className="caption__who">{l.speaker}</span> {l.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
