import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { ConversationMode } from "@rcai/conversation-core";
import type { Persona } from "@rcai/persona-core";
import { probe, type AgentHealth, type BrokerHealth } from "./api/health.js";
import { withRealistic } from "./components/characters.js";
import { FALLBACK_PERSONAS } from "./content/fallbackPersonas.js";
import { loadCharacterEntries, loadPersonas, type CharacterEntry } from "./integrations/registry.js";
import { CharacterSelect } from "./screens/CharacterSelect.jsx";
import { Home } from "./screens/Home.jsx";
import { Result } from "./screens/Result.jsx";
import { Session } from "./screens/Session.jsx";
import { SettingsScreen } from "./screens/SettingsScreen.jsx";
import { Meeting } from "./screens/Meeting.jsx";
import { Setup } from "./screens/Setup.jsx";
import type { SessionOutcome } from "./session/SessionController.js";
import { loadSettings, saveSettings, settingsReducer, type Availability } from "./state/settings.js";
import { loadRecent, saveRecent, type Recent } from "./state/recent.js";
import { disposeActiveSession } from "./session/activeSession.js";

type Screen =
  | { name: "home" }
  | { name: "settings" }
  | { name: "character"; back: "home" | "settings" | "setup"; mode?: ConversationMode }
  | { name: "meeting" }
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
      if (p.personas.length) setPersonas(p.personas);
      else {
        setPersonas(FALLBACK_PERSONAS);
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
    const r = await probe(settings.brokerUrl, settings.agentUrl, settings.privacyMode);
    setBroker(r.broker);
    setAgent(r.agent);
    setAvailability(r.availability);
  }, [settings.brokerUrl, settings.agentUrl, settings.privacyMode]);

  useEffect(() => {
    void refreshHealth();
    const t = setInterval(() => void refreshHealth(), 10_000);
    return () => clearInterval(t);
  }, [refreshHealth]);

  useEffect(() => {
    if (!settings.characterId && characters[0]) dispatch({ type: "character", id: characters[0].id });
  }, [characters, settings.characterId]);

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
      const list = personasByMode.get(mode) ?? [];
      const single = list.length === 1 ? list[0] : undefined;
      if (single && !(single.params?.length)) startSession(single, {});
      else setScreen({ name: "setup", mode });
    },
    [personasByMode, startSession],
  );

  const inSession = screen.name === "session" || (screen.name === "meeting" && !!botParams);
  const brokerMeeting = broker?.meeting ?? null;
  return (
    <div className="app">
      {!inSession && (
        <header className="topbar">
          <a className="brand" href="#" onClick={(e) => { e.preventDefault(); setScreen({ name: "home" }); }}>
            <span className="brand__mark">稽古場</span>
            <span className="brand__sub">Stage</span>
          </a>

        </header>
      )}
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
          onCharacter={() => setScreen({ name: "character", back: "home" })}
          onSettings={() => setScreen({ name: "settings" })}
          onMeeting={() => setScreen({ name: "meeting" })}
        />
      )}
      {screen.name === "settings" && (
        <SettingsScreen
          settings={settings}
          dispatch={dispatch}
          availability={availability}
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
        <Meeting settings={settings} availability={availability} personas={personas} characters={characters} botParams={botParams} brokerMeeting={brokerMeeting} onBack={() => setScreen({ name: "home" })} />
      )}
      {screen.name === "setup" && (
        <Setup
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
      {screen.name === "result" && <Result outcome={screen.outcome} onHome={() => setScreen({ name: "home" })} onAgain={() => setScreen(screen.last)} />}
    </div>
  );
}
