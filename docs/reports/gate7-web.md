# Gate 7 — apps/web (Free Talk / Interview / English) — report (Fork F, 2026-08-30)

## Status
`pnpm --filter @rcai/web typecheck` → Done (0 errors) · `pnpm vitest run apps/web` → 3 files / 8 tests passed · `pnpm --filter @rcai/web build` → ✓ built (Vite 7).
Browser/device verification: **not run by this fork** (browser reserved for the Live2D fork). Gate 7 remains `PARTIAL` until a real session is exercised in Chrome.

## Files (all under apps/web/)
- `index.html`, `vite.config.ts` — React plugin, `server.fs.allow=[repo root]`, `publicDir` with `public/characters` symlink, proxies `/api`→8787 and `/agent`→8788 (ws).
- `src/main.tsx`, `src/App.tsx` — screen state machine: home → setup → session → result (+ settings); loads `@rcai/personas` / `@rcai/characters` lazily with built-in fallback personas (`src/content/fallbackPersonas.ts`, flagged in UI); probes broker/agent `/health` every 10 s (broker skipped under strict_local).
- `src/state/settings.ts` (+ `settings.test.ts`) — §7 settings reducer (engine / Auto policy / Advanced per-role / strict_local forcing local & clearing cloud overrides), `decide()` via `resolveRouting` with availability fallback, localStorage persistence that strips any key/secret/token fields (§26).
- `src/integrations/registry.ts` — **the only file importing sibling packages**; dynamic `import()` per package, typed against core contracts; missing export ⇒ `IntegrationMissingError("BLOCKED_BY_…")`. Exports `createConversationProvider`, `createEvaluator`, `createHeuristicEvaluator`, `createAvatarProvider`, `loadCharacterEntries`, `loadPersonas`, `plannerUrl`.
- `src/session/SessionController.ts` — wiring: `SpeakerOutput` (sink+tap) → `ConversationRuntime{localVad}` → routed `RealtimeAIProvider`; `AvatarRuntime` + `BehaviorEngine` (`RemoteSemanticPlanner` → broker `/api/plan` or agent `/plan` for local/strict; heuristic fallback inside the planner); `speaker.tap → avatarRuntime.pushAudio`; mic level → `behavior.reportUserAudio`; `EvaluationSidecar`; `createSessionConfig` (persona+character+policy, no secrets); opening line sent as a provider-agnostic text turn; `switchProvider()` (Gate D) keeps avatar/UI and re-attaches the mic stream.
- `src/session/useSession.ts` — React hook: status, avatar state, captions (partial/final merge), provider id, latency report (500 ms poll), toasts (BLOCKED_BY_* codes extracted), mute, end.
- `src/session/sidecar.ts` — `recordToEvaluationInput` (no audio), `EvaluationSidecar` with English deferred feedback every 4 user turns (collected silently, shown only on the result screen) and heuristic fallback at finalize.
- `src/session/pill.ts` (+ test) — AvatarState → status pill.
- Screens: `Home.tsx` (products, character picker with Realistic entries + BLOCKED reasons from `/health`, §7 engine selector, strict_local toggle), `Setup.tsx` (§19 fields from `persona.params`, English mode chips §20, Interviewer select, AI Engine), `Session.tsx` (§19 layout: stage, ● state pill, You PiP, 🎤 📷 CC End, tap-to-interrupt, latency HUD toggle, in-session provider switch menu; **no scores**), `Result.tsx` (§21 fields, feedback, improved answer, deferred feedback, stats, transcript), `SettingsScreen.tsx` (URLs + HUD; no key field).
- Components: `EngineSelector`, `CharacterPicker`, `LatencyHud`, `Captions`, `SelfCamera`, `Toasts`. Styles: `src/styles/global.css` (dark stage, amber accent, Shippori Mincho / Zen Kaku Gothic / IBM Plex Mono via Google Fonts).

## Commands run
```
pnpm --filter @rcai/web typecheck      # Done
pnpm vitest run apps/web               # 3 passed (8 tests)
pnpm --filter @rcai/web build          # ✓ built in ~2 s
```

## Sibling integration check (re-run after they landed)
All registry names resolve against the landed packages: `OpenAIRealtimeProvider`, `createOpenAIEvaluationProvider`, `GeminiLiveProvider`, `createGeminiEvaluationProvider`, `LocalProvider`, `createLocalEvaluationProvider`, `HeuristicEvaluator`, `Live2DAvatarProvider`, `CanvasAvatarProvider`, `VRMAvatarProvider`, `LiveAvatarProvider`, `TavusAvatarProvider`, `characters`, `personas`. Option shapes used (`{brokerUrl, model?}`, `{agentUrl}`, `{container}`, `{brokerUrl, container}`) are subsets of each package's options interface. Build output includes cubism4/pixi/livekit/daily chunks (code-split per provider).

## Pending / not verified
- Real browser session (mic permission, AudioContext unlock, Live2D render, provider connect) — needs Chrome run + broker/agent up; keys ⇒ BLOCKED_BY_OPENAI_KEY / BLOCKED_BY_GEMINI_KEY for cloud paths.
- Camera frames are displayed only; `pushImage` (vision) is not wired to providers.
- `@rcai/personas` also exports `personasByMode`; the app groups by mode itself and does not depend on it.
- Vitest runs these tests in node (pure logic); no jsdom component tests were added.
