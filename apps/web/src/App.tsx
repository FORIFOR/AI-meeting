import { memoryContext, readConversationMemory } from "./state/conversationMemory.js";
import { ZoomReturn } from "./components/ZoomConnection.js";
import { lazy, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { ScreenBoundary } from "./components/ScreenBoundary.js";
import type { ConversationMode } from "@rcai/conversation-core";
import type { Persona } from "@rcai/persona-core";
import { probe, shouldProbeLocalAgent, type AgentHealth, type BrokerHealth } from "./api/health.js";
import { withRealistic } from "./components/characters.js";
import { FALLBACK_PERSONAS } from "./content/fallbackPersonas.js";
import { loadCharacterEntries, loadPersonas, type CharacterEntry } from "./integrations/registry.js";
import { Home } from "./screens/Home.jsx";
import type { SessionOutcome } from "./session/SessionController.js";
import { loadSettings, saveSettings, settingsReducer, type Availability } from "./state/settings.js";
import { loadRecent, saveRecent, type Recent } from "./state/recent.js";
import { disposeActiveSession } from "./session/activeSession.js";
import { availableMode } from "./content/release.js";

// Keep meeting/session engines out of the first home render. Preloading only downloads
// code: microphone, camera and provider connections still start when their screen mounts.
const loadMeeting = () => import("./screens/Meeting.js").then((m) => ({ default: m.Meeting }));
const loadMeetings = () => import("./screens/Meetings.js").then((m) => ({ default: m.Meetings }));
const loadSettingsScreen = () => import("./screens/SettingsScreen.js").then((m) => ({ default: m.SettingsScreen }));
const loadSession = () => import("./screens/Session.js").then((m) => ({ default: m.Session }));
const Meeting = lazy(loadMeeting);
const Meetings = lazy(loadMeetings);
const SettingsScreen = lazy(loadSettingsScreen);
const Session = lazy(loadSession);
const CharacterSelect = lazy(() => import("./screens/CharacterSelect.js").then((m) => ({ default: m.CharacterSelect })));
const MeetingDetail = lazy(() => import("./screens/MeetingDetail.js").then((m) => ({ default: m.MeetingDetail })));
const Setup = lazy(() => import("./screens/Setup.js").then((m) => ({ default: m.Setup })));
const Result = lazy(() => import("./screens/Result.js").then((m) => ({ default: m.Result })));
const ThinkingResult = lazy(() => import("./screens/ThinkingResult.js").then((m) => ({ default: m.ThinkingResult })));

function preload(load: () => Promise<unknown>) {
  // A failed speculative request must not produce an unhandled rejection. The actual
  // navigation has a visible error boundary and can reload after a deployment/network failure.
  void load().catch(() => {});
}

type Screen =
  | { name: "home" }
  | { name: "settings" }
  | { name: "character"; back: "home" | "settings" | "setup"; mode?: ConversationMode }
  | { name: "meeting" }
  | { name: "meetings" }
  | { name: "meetingDetail"; id: string }
  | { name: "setup"; mode: ConversationMode }
  | { name: "session"; persona: Persona; character: CharacterEntry; params: Record<string, string>; availability: Availability }
  | { name: "result"; outcome: SessionOutcome; last: Extract<Screen, { name: "session" }> };

/**
 * `?rcai_bot=1&token=…` means this page is running inside a meeting bot (Recall Output Media) — render only the character.
 * The token is a signed, single-use, ≤15-min session token (Round 3 Gate 5); everything else (character, persona, engine,
 * name) is fetched from the broker after activation, so nothing in the query string is trusted.
 */
function readBotParams(): { token: string; brokerUrl?: string; botId?: string; characterId?: string; personaId?: string; displayName?: string; proactivity?: string } | null {
  if (typeof location === "undefined") return null;
  const q = new URLSearchParams(location.search);
  if (q.get("rcai_bot") !== "1") return null;
  const token = q.get("token") ?? "";
  let brokerUrl: string | undefined;
  let botId: string | undefined;
  const body = token.split(".")[0];
  if (body) {
    try {
      const pad = body.length % 4 === 0 ? "" : "=".repeat(4 - (body.length % 4));
      const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/") + pad)) as { brk?: string; bot?: string };
      brokerUrl = payload.brk;
      botId = payload.bot || undefined;
    } catch {
      /* the broker will reject it */
    }
  }
  return { token, brokerUrl, botId, characterId: q.get("character") ?? undefined, personaId: q.get("persona") ?? undefined, displayName: q.get("name") ?? undefined, proactivity: q.get("proactivity") ?? undefined };
}

export function App() {
  const [settings, dispatch] = useReducer(settingsReducer, undefined, () => loadSettings());
  const botParams = useMemo(() => readBotParams(), []);
  const [screen, setScreen] = useState<Screen>(botParams ? { name: "meeting" } : { name: "home" });
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [characters, setCharacters] = useState<CharacterEntry[]>([]);
  const [contentNote, setContentNote] = useState<string | undefined>();
  const [broker, setBroker] = useState<BrokerHealth | null>(null);
  const [agent, setAgent] = useState<AgentHealth | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [recent, setRecent] = useState<Recent | null>(() => loadRecent());

  useEffect(() => saveSettings(settings), [settings]);

  // Any route change away from a live screen (and App unmount) releases the session's audio
  // resources even if the screen's own cleanup did not run (docs/audio-lifecycle.md).
  useEffect(() => {
    if (screen.name !== "session" && screen.name !== "meeting") void disposeActiveSession();
    return () => {
      void disposeActiveSession();
    };
  }, [screen.name]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [p, c] = await Promise.all([loadPersonas(), loadCharacterEntries()]);
      if (!alive) return;
      const notes: string[] = [];
      if (p.personas.length) setPersonas(p.personas.filter((persona) => availableMode(persona.mode)));
      else {
        setPersonas(FALLBACK_PERSONAS.filter((persona) => availableMode(persona.mode)));
        notes.push(`personas: built-in fallback (${p.error ?? "empty"})`);
      }
      const entries = withRealistic(c.entries);
      setCharacters(entries);
      if (!c.entries.length) notes.push(`characters: ${c.error ?? "none available"}`);
      setContentNote(notes.length ? notes.join(" · ") : undefined);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refreshHealth = useCallback(async () => {
    const r = await probe(settings.brokerUrl, settings.agentUrl, settings.privacyMode, { agent: shouldProbeLocalAgent(settings) });
    setBroker(r.broker);
    setAgent(r.agent);
    setAvailability(r.availability);
  }, [settings.brokerUrl, settings.agentUrl, settings.privacyMode, settings.engine, settings.advanced]);

  useEffect(() => {
    void refreshHealth();
    const t = setInterval(() => void refreshHealth(), 10_000);
    return () => clearInterval(t);
  }, [refreshHealth]);

  useEffect(() => {
    if (!settings.characterId && characters[0]) dispatch({ type: "character", id: characters[0].id });
  }, [characters, settings.characterId]);

  useEffect(() => {
    if (screen.name === "setup") preload(loadSession);
  }, [screen.name]);

  const personasByMode = useMemo(() => {
    const m = new Map<ConversationMode, Persona[]>();
    for (const p of personas) m.set(p.mode, [...(m.get(p.mode) ?? []), p]);
    return m;
  }, [personas]);

  const selectedCharacter = characters.find((c) => c.id === settings.characterId) ?? characters[0];

  const startSession = useCallback(
    (persona: Persona, params: Record<string, string>) => {
      if (!selectedCharacter) return;
      const r: Recent = { mode: persona.mode, characterId: selectedCharacter.id, characterName: selectedCharacter.name, personaId: persona.id, at: Date.now() };
      saveRecent(r);
      setRecent(r);
      setScreen({ name: "session", persona, character: selectedCharacter, params, availability: availability ?? { openai: false, google: false, local: false } });
    },
    [selectedCharacter, availability],
  );

  const onContinue = useCallback(
    (mode: ConversationMode) => {
      // Always show the setup screen first, even for a mode with one default persona.
      // This keeps a visible "戻る" action after a purpose has been selected.
      setScreen({ name: "setup", mode });
    },
    [],
  );

  const inSession = screen.name === "session" || (screen.name === "meeting" && !!botParams);
  const brokerMeeting = broker?.meeting ?? null;
  const [meetingDraft, setMeetingDraft] = useState("");
  return (
    <div className="app">
      <ZoomReturn privacyMode={settings.privacyMode} onDone={() => setScreen({ name: "meeting" })} />
      {!inSession && (
        <header className="topbar">
          <a className="brand" href="#" onClick={(e) => { e.preventDefault(); setScreen({ name: "home" }); }}>
            <span className="brand__mark">AIミーティング</span>
            <span className="brand__sub">Realtime Character AI</span>
          </a>
          <nav className="workspace-nav" aria-label="メインメニュー">
            <button aria-current={screen.name === "home" ? "page" : undefined} onClick={() => setScreen({ name: "home" })}>ホーム</button>
            <button aria-current={screen.name === "meeting" ? "page" : undefined} onPointerEnter={() => preload(loadMeeting)} onFocus={() => preload(loadMeeting)} onClick={() => setScreen({ name: "meeting" })}>会議</button>
            <button aria-current={screen.name === "meetings" ? "page" : undefined} onPointerEnter={() => preload(loadMeetings)} onFocus={() => preload(loadMeetings)} onClick={() => setScreen({ name: "meetings" })}>会議の履歴</button>
            <button aria-current={screen.name === "settings" ? "page" : undefined} onPointerEnter={() => preload(loadSettingsScreen)} onFocus={() => preload(loadSettingsScreen)} onClick={() => setScreen({ name: "settings" })}>設定</button>
          </nav>
        </header>
      )}
      <ScreenBoundary key={screen.name} onHome={() => setScreen({ name: "home" })}>
      {screen.name === "home" && (
        <Home
          settings={settings}
          dispatch={dispatch}
          personas={personas}
          characters={characters}
          broker={broker}
          agent={agent}
          contentNote={contentNote}
          recent={recent}
          onContinue={onContinue}
          onResume={() => { const memory = readConversationMemory(selectedCharacter?.id ?? "yui"); const persona = personas.find(p => p.id === "thinking_ja"); if (memory && persona) startSession(persona, { previousMemory: memoryContext(memory) }); }}
          onTalk={personas.some(p => p.id === "thinking_ja") ? () => startSession(personas.find(p => p.id === "thinking_ja")!, {}) : undefined}
          onCharacter={() => setScreen({ name: "character", back: "home" })}
          onSettings={() => setScreen({ name: "settings" })}
          onMeeting={(url) => { setMeetingDraft(url ?? ""); setScreen({ name: "meeting" }); }}
        />
      )}
      {screen.name === "settings" && (
        <SettingsScreen
          settings={settings}
          dispatch={dispatch}
          availability={availability}
          agentHealth={agent}
          characters={characters}
          onCharacter={() => setScreen({ name: "character", back: "settings" })}
          onBack={() => setScreen({ name: "home" })}
        />
      )}
      {screen.name === "character" && (
        <CharacterSelect
          characters={characters}
          settings={settings}
          dispatch={dispatch}
          broker={broker}
          onDone={() => setScreen(screen.back === "setup" && screen.mode ? { name: "setup", mode: screen.mode } : screen.back === "settings" ? { name: "settings" } : { name: "home" })}
        />
      )}
      {screen.name === "meeting" && (
        <Meeting initialUrl={meetingDraft} settings={settings} availability={availability} personas={personas} characters={characters} botParams={botParams} broker={broker} brokerMeeting={brokerMeeting} onBack={() => setScreen({ name: "home" })} />
      )}
      {screen.name === "meetings" && (
        <Meetings
          settings={settings}
          brokerMeeting={brokerMeeting}
          onOpenMeeting={(id) => setScreen({ name: "meetingDetail", id })}
          onUrlFlow={() => setScreen({ name: "meeting" })}
          onBack={() => setScreen({ name: "home" })}
        />
      )}
      {screen.name === "meetingDetail" && (
        <MeetingDetail settings={settings} meetingId={screen.id} onBack={() => setScreen({ name: "meetings" })} />
      )}
      {screen.name === "setup" && (
        <Setup
          availability={availability}
          agent={agent}
          mode={screen.mode}
          personas={personasByMode.get(screen.mode) ?? []}
          characters={characters}
          settings={settings}
          dispatch={dispatch}
          onBack={() => setScreen({ name: "home" })}
          onCharacter={() => setScreen({ name: "character", back: "setup", mode: screen.mode })}
          onStart={startSession}
        />
      )}
      {screen.name === "session" && (
        <Session
          settings={settings}
          dispatch={dispatch}
          availability={screen.availability}
          persona={screen.persona}
          character={screen.character}
          params={screen.params}
          onEnded={(outcome) => setScreen({ name: "result", outcome, last: screen })}
          onAbort={() => setScreen({ name: "home" })}
        />
      )}
      {screen.name === "result" && (screen.last.persona.id === "thinking_ja" ? <ThinkingResult outcome={screen.outcome} onHome={() => setScreen({ name: "home" })} onAgain={() => setScreen(screen.last)} /> : <Result outcome={screen.outcome} onHome={() => setScreen({ name: "home" })} onAgain={() => setScreen(screen.last)} />)}
      </ScreenBoundary>
    </div>
  );
}
