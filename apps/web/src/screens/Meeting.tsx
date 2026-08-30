import { useEffect, useMemo, useRef, useState } from "react";
import type { Persona } from "@rcai/persona-core";
import type { MeetingStatus, ParticipationState, Proactivity } from "@rcai/meeting-core";
import type { AvatarState } from "@rcai/avatar-core";
import type { CharacterEntry } from "../integrations/registry.js";
import type { Availability, Settings } from "../state/settings.js";
import { MeetingSessionController, type MeetingTranscriptLine } from "../session/MeetingSessionController.js";
import { pillFor } from "../session/pill.js";

export interface MeetingProps {
  settings: Settings;
  availability: Availability | null;
  personas: Persona[];
  characters: CharacterEntry[];
  /** Present when this page runs inside the Recall bot (Output Media). */
  botParams?: { token: string; brokerUrl?: string; botId?: string; characterId?: string; personaId?: string; displayName?: string; proactivity?: string } | null;
  brokerMeeting?: { recall: boolean; recallPublicUrl: boolean; recallBotPageUrl: boolean } | null;
  onBack: () => void;
}

const STATUS_JA: Record<MeetingStatus, string> = {
  created: "作成済み", joining: "参加中…", waiting_room: "待機室（承認待ち）", in_call_not_recording: "入室（音声待ち）", in_call: "会議に参加中", reconnecting: "再接続中…", leaving: "退出中", left: "退出しました", denied: "入室が拒否されました", removed: "ホストに退出させられました", ended: "会議が終了しました", failed: "失敗",
};
const POLICY_JA: Record<ParticipationState, string> = { OBSERVING: "見守り中", LISTENING: "聞いています", ADDRESSED: "呼ばれました", RESPONDING: "返答中" };

/** P0-1: join a Google Meet / Zoom as the character. Operator view + bot-page view share one controller. */
export function Meeting(p: MeetingProps) {
  const isBot = Boolean(p.botParams);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [personaId, setPersonaId] = useState("");
  const [proactivity, setProactivity] = useState<Proactivity>("addressed_only");
  const [mode, setMode] = useState<"output_media" | "relay">("output_media");
  const [status, setStatus] = useState<MeetingStatus | null>(null);
  const [timeline, setTimeline] = useState<{ at: number; text: string }[]>([]);
  const [policy, setPolicy] = useState<ParticipationState>("OBSERVING");
  const [avatarState, setAvatarState] = useState<AvatarState>("IDLE");
  const [muted, setMuted] = useState(false);
  const [activation, setActivation] = useState<{ sessionId: string; botId: string } | null>(null);
  /** Bot page: render config returned by the broker after the single-use token was accepted (never from the URL). */
  const [botConfig, setBotConfig] = useState<{ characterId?: string; personaId?: string; displayName?: string; proactivity?: string; engine?: string } | null>(null);
  const [lines, setLines] = useState<MeetingTranscriptLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ctrl = useRef<MeetingSessionController | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const t0 = useRef(Date.now());

  const character = useMemo(() => p.characters.find((c) => c.id === (isBot ? botConfig?.characterId : p.settings.characterId)) ?? p.characters[0], [p.characters, p.settings.characterId, isBot, botConfig]);
  const persona = useMemo(() => p.personas.find((x) => x.id === (isBot ? botConfig?.personaId : personaId)) ?? p.personas.find((x) => x.mode === "free_talk") ?? p.personas[0], [p.personas, personaId, isBot, botConfig]);
  const displayName = (isBot ? botConfig?.displayName : name) || character?.name || "Yui";
  const strict = p.settings.privacyMode === "strict_local";
  const blocked = strict ? "BLOCKED_BY_STRICT_LOCAL" : p.brokerMeeting && !p.brokerMeeting.recall ? "BLOCKED_BY_RECALL_KEY" : p.brokerMeeting && !p.brokerMeeting.recallPublicUrl ? "BLOCKED_BY_RECALL_PUBLIC_URL" : null;

  const note = (text: string) => setTimeline((t) => [...t.slice(-60), { at: Date.now() - t0.current, text }]);

  const start = async (role: "operator" | "bot") => {
    if (!character || !persona) return;
    setBusy(true);
    setError(null);
    try {
      const c = new MeetingSessionController({
        settings: p.settings,
        availability: p.availability ?? { openai: false, google: false, local: false },
        persona,
        character,
        meetingUrl: url,
        displayName,
        proactivity: (isBot ? (botConfig?.proactivity as Proactivity | undefined) : undefined) ?? proactivity,
        role,
        botToken: isBot ? p.botParams?.token : undefined,
        botBrokerUrl: isBot ? p.botParams?.brokerUrl : undefined,
        botActivation: isBot && activation ? activation : undefined,
        connectorMode: mode,
        stage: role === "bot" || mode === "relay" ? stage.current : null,
        botTranscriptFeed: role === "bot" ? (cb) => {
          let stop: (() => void) | null = null;
          void import("@rcai/connector-recall").then((m) => { stop = m.connectBotTranscript(cb); });
          return () => stop?.();
        } : undefined,
        handlers: {
          onStatus: (s, d) => { setStatus(s); note(`${STATUS_JA[s]}${d ? ` · ${d}` : ""}`); },
          onTranscript: (line) => setLines((ls) => {
            const i = ls.findIndex((x) => !x.final && x.speaker === line.speaker && !x.self);
            if (!line.final && i >= 0) return ls.map((x, k) => (k === i ? line : x));
            return [...ls.filter((x) => x.final || x.speaker !== line.speaker), line].slice(-80);
          }),
          onPolicy: (t) => { setPolicy(t.to); note(`${POLICY_JA[t.from]} → ${POLICY_JA[t.to]} (${t.reason})`); },
          onAvatarState: (t) => setAvatarState(t.to),
          onMuted: (m) => { setMuted(m); note(m ? "ホストにミュートされました（発話を保留）" : "ミュート解除"); },
          onActivated: (a) => { setActivation(a); note(`bot page activated · session ${a.sessionId.slice(0, 8)} · bot ${a.botId}`); },
          onError: (m, code) => { setError(`${code ? `${code}: ` : ""}${m}`); note(`error ${m}`); },
        },
      });
      ctrl.current = c;
      await c.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      note(`error ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Bot page step 1: activate the signed single-use token with the broker; the render config comes back server-side.
  useEffect(() => {
    if (!isBot || activation || error) return;
    const token = p.botParams?.token ?? "";
    if (!token) { setError("BOT_PAGE_TOKEN_REQUIRED"); return; }
    let alive = true;
    void (async () => {
      try {
        const m = await import("@rcai/connector-recall");
        const act = await m.activateBotPage(p.botParams?.brokerUrl ?? p.settings.brokerUrl, token);
        if (!alive) return;
        setBotConfig({ characterId: act.botPageQuery.character, personaId: act.botPageQuery.persona, displayName: act.botPageQuery.name, proactivity: act.botPageQuery.proactivity, engine: act.botPageQuery.engine });
        setActivation({ sessionId: act.sessionId, botId: act.botId });
        note(`activated · session ${act.sessionId.slice(0, 8)} · bot ${act.botId} · activation #${act.activations}`);
      } catch (e) {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg); // BOT_PAGE_ACTIVATION_401:replayed / expired / revoked → never start
        note(`activation refused: ${msg}`);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBot]);

  // Bot page step 2: start once activated and content is loaded (the bot grants mic access without a gesture).
  useEffect(() => {
    if (isBot && activation && !ctrl.current && character && persona && p.characters.length && p.personas.length) void start("bot");
    return () => { void ctrl.current?.leave(); ctrl.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBot, activation, character?.id, persona?.id, p.characters.length, p.personas.length]);

  const leave = async () => {
    setBusy(true);
    await ctrl.current?.leave();
    ctrl.current = null;
    setBusy(false);
    setStatus("left");
  };

  const pill = pillFor(avatarState, false);
  const terminal = status === "left" || status === "failed" || status === "denied" || status === "removed" || status === "ended";
  const joined = status !== null && !terminal;

  if (isBot) {
    return (
      <div className="session session--bot">
        <div className="stage" ref={stage}>
          <div className={`pill pill--${pill.key}`}><span className="pill__dot" /> {muted ? "ミュート中" : POLICY_JA[policy]} <span style={{ opacity: 0.5 }}>{pill.en}</span></div>
          {!activation && !error && <div className="err" style={{ position: "absolute", bottom: 12, left: 12, opacity: 0.6 }}>activating…</div>}
          {error && <div className="err" style={{ position: "absolute", bottom: 12, left: 12 }}>{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="setup meeting">
      <div className="card">
        <div className="card__head">
          <div className="card__kana">Join a meeting</div>
          <h2>会議に参加</h2>
          <p className="card__lede">Google Meet / Zoom の URL を入れると、{displayName} が参加者として入室します。名前で呼ばれたときだけ答えます（{POLICY_JA[policy]}）。</p>
        </div>
        {blocked && <p className="err">{blocked}{blocked === "BLOCKED_BY_RECALL_PUBLIC_URL" ? " — broker を公開URL(ngrok等)で公開し RECALL_PUBLIC_URL / RECALL_BOT_PAGE_URL を設定してください" : blocked === "BLOCKED_BY_RECALL_KEY" ? " — services/token-broker/.env に RECALL_API_KEY を設定してください" : ""}</p>}
        <div className="field"><label>Meeting URL</label><input className="input" placeholder="https://meet.google.com/xxx-xxxx-xxx" value={url} onChange={(e) => setUrl(e.target.value)} disabled={joined} /></div>
        <div className="field"><label>表示名 · Display name</label><input className="input" value={name} placeholder={character?.name ?? "Yui"} onChange={(e) => setName(e.target.value)} disabled={joined} /></div>
        <div className="field"><label>ペルソナ · Persona</label>
          <select className="select" value={persona?.id ?? ""} onChange={(e) => setPersonaId(e.target.value)} disabled={joined}>
            {p.personas.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.mode}</option>)}
          </select>
        </div>
        <div className="field"><label>発言ポリシー · Participation</label>
          <select className="select" value={proactivity} onChange={(e) => setProactivity(e.target.value as Proactivity)} disabled={joined}>
            <option value="addressed_only">名前で呼ばれたときだけ（推奨）</option>
            <option value="invited">「誰か意見ある？」にも答える</option>
            <option value="active">未回答の質問にも自発的に答える</option>
          </select>
        </div>
        <div className="field"><label>接続モード · Mode</label>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} disabled={joined}>
            <option value="output_media">output_media — bot がこのアプリを表示・発話（推奨、映像あり）</option>
            <option value="relay">relay — このブラウザで会話（音声出力はMP3クリップ）</option>
          </select>
        </div>
        <div className="actions">
          <button type="button" className="btn btn--ghost" onClick={p.onBack} disabled={busy}>← 戻る</button>
          {!joined ? (
            <button type="button" className="btn btn--primary btn--lg" disabled={busy || !url || !!blocked || !character} onClick={() => void start("operator")}>参加する · Join</button>
          ) : (
            <>
              <button type="button" className="btn btn--ghost" onClick={() => ctrl.current?.hush()}>黙らせる · Hush</button>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void leave()}>退出 · Leave</button>
            </>
          )}
        </div>
        {error && <p className="err">{error}</p>}
      </div>
      <div className="card">
        <h3>状態 <small>{status ? STATUS_JA[status] : "未参加"}{muted ? " · ミュート中" : ""} · {POLICY_JA[policy]} · {ctrl.current?.botId ?? ""}</small></h3>
        <div className="stage stage--mini" ref={stage} style={{ display: mode === "relay" ? "block" : "none" }} />
        <ul className="timeline">{timeline.map((t, i) => <li key={i}><span className="mono">{(t.at / 1000).toFixed(1)}s</span> {t.text}</li>)}</ul>
        <h3>会議の文字起こし <small>transcript</small></h3>
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
