# Round 3 — Gate 2: AudioWorklet lifecycle / AbortError elimination (2026-08-30)

## Root cause (reproduced, not guessed)
`AbortError: Unable to load a worklet's module` = Chrome's response when an `AudioContext` is **closed while `audioWorklet.addModule()` is still in flight** (also when the Blob URL is revoked early). Minimal repro in real Chrome (10 runs each): `close_during` 10/10 abort, `revoke_early` 10/10 abort; concurrent double registration, sequential re-registration and `setSinkId` during load: 0/10.

In the web app this happened on **every session mount in development**: React StrictMode mounts effects twice — the first `SessionController.start()` created `SpeakerOutput` (→ `addModule`), the effect cleanup called `dispose()` → `context.close()` mid-load, the un-awaited `ready` promise rejected → `pageerror`. The second mount worked, so the session ran fine; the error was pure lifecycle noise — but it also meant a real abort (route change/unload mid-start) could leave a context/track behind.

## Fix
- `packages/audio-core/src/worklet.ts`: one registration per context with the in-flight promise shared by concurrent callers; page-lifetime Blob URL (never revoked while a load could read it); typed `WorkletUnavailableError(reason: closed|aborted|unsupported)`; early-reject paths are pre-handled so fire-and-forget callers never create unhandled rejections; `PcmTapNode.dispose()` idempotent (port closed, processor returns `false`, node disconnected).
- `SpeakerOutput` (readiness/close only): a `close()` that races the worklet load releases the tap when it arrives, `ready` never rejects on a closed sink, `close()` idempotent, owned-context rule (`{ context }` option ⇒ not closed).
- `MicCapture`: idempotent `stop()` safe while `start()` is in flight (tracks obtained after stop are stopped immediately), owned-context rule, teardown order tracks → tap → source → (owned) context.
- `SessionController`: `AbortController` owned by the controller; every `await` in `start()` is followed by `checkpoint()` → `SessionDisposedError`; partial resources released by the same `teardown()` (abort → behavior → mic tracks → runtime/provider → avatar → speaker/context); `dispose()` memoised/idempotent; `end()` uses the same path; `setSinkId` applied only after the worklet is wired.
- `useSession` ignores `SessionDisposedError`; `App.tsx` disposes the active session on route change/unmount; `activeSession.ts` also disposes on `pagehide`.
- Dev/`?debug=1` registry `apps/web/src/audio/debugRegistry.ts` (`window.__rcaiAudio.live()` → live contexts/tracks; wraps `AudioContext` and `getUserMedia`).
- `docs/audio-lifecycle.md` — ownership table, teardown order, rules.

## Evidence — `apps/web/scripts/lifecycle-stress.mjs` (real headless Chrome 152, fake mic, strict_local, Live2D yui, agent on :8793)
100 iterations: Home → Free Talk session (live, avatar Listening/Speaking) → wait 1.5 s → End → Result → Home; every 3rd iteration an abrupt full navigation instead of End (pagehide path); every 10th a fresh page load. `docs/reports/img/r3-lifecycle.json`.

| Metric | Result | PASS rule |
|---|---|---|
| Uncaught exceptions (`pageerror`) | **0** | 0 |
| `console.error` (favicon excluded) | **0** | 0 |
| Leaked `AudioContext` after teardown (per iteration) | **0 / 100** | 0 |
| Leaked `MediaStreamTrack` after teardown | **0 / 100** | 0 |
| Live during session | 1 context / 1 track (StrictMode's first controller already released) | — |
| JS heap | 9 MB → 31 MB (max 31 MB; plateau from iteration ~20, fresh loads every 10) | no unbounded growth |
| Iteration time | median 19.4 s (End path includes local evaluation), min 2.6 s | — |

Result: **PASS** (`summary.pass = true`).

## Tests
- `packages/audio-core/src/lifecycle.test.ts` (7): worklet dedupe/shared promise, closed-mid-load → `WorkletUnavailableError('closed')` with **no unhandled rejection**, closed-context node refusal, idempotent tap dispose, speaker close racing the load, owned vs shared context rules, mic stop during start.
- `apps/web/src/session/SessionController.lifecycle.test.ts` (2): dispose during start aborts at a checkpoint and releases everything (context closed once, active session cleared, idempotent); full start→end closes the context exactly once.
- `pnpm -r typecheck` clean. `pnpm vitest run` (final): **34 files / 296 tests pass** (an earlier interim run showed 3 transient failures in `connectors/recall` while another fork was mid-edit; they pass now).

## Notes
- The transient "change in the order of Hooks" console error seen once during development was Vite HMR applying another fork's new hooks to a mounted `Session` — not reproducible on a fresh load; the 100× run had 0 console errors.
- Processes started by this fork (agent :8793, vite :5177) were stopped; llama-server (shared) left running.
