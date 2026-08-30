# Audio lifecycle — ownership and teardown order

Round 3 Gate 2. Root cause of the historical `AbortError: Unable to load a worklet's module`: an
`AudioContext` was **closed while `audioWorklet.addModule()` was still in flight**. In the web app this
happened on every session mount in development because React StrictMode mounts effects twice: the
first `SessionController` started (`SpeakerOutput` → `addModule`), the effect cleanup disposed it
(`context.close()`), Chrome aborted the load and the un-awaited `ready` promise rejected → `pageerror`.
Reproduced in real Chrome (`close_during` and `revoke_early` variants abort 10/10; concurrent or
sequential double registration and `setSinkId` during load do not).

## Ownership

| Resource | Created by | Closed by | Notes |
|---|---|---|---|
| `AudioContext` (one per session, 48 kHz) | `SpeakerOutput` (no `context` option) | `SpeakerOutput.close()` | `MicCapture` receives it via `{ context }` and **never** closes a context it did not create. Providers that need their own context (OpenAI pushAudio fallback) own and close it themselves. |
| PCM tap worklet module | `ensurePcmTapWorklet(ctx)` — once per context, concurrent callers share the promise | page lifetime (Blob URL kept until unload) | closing the context mid-load rejects with `WorkletUnavailableError("closed")`; never unhandled. |
| `AudioWorkletNode` taps (speaker, mic) | `createPcmTapNode` | `PcmTapNode.dispose()` (idempotent: port closed, processor returns `false`, node disconnected) | disposed by their owner before the context closes. |
| `MediaStream` + tracks (mic) | `MicCapture.start()` | `MicCapture.stop()` (idempotent, safe mid-start) | tracks stopped **first** so no frame reaches a dying provider. |
| Assistant `MediaStream` (WebRTC) | provider | provider `disconnect()`; sink `detachStream()` | sink only disconnects the source node. |
| `AbortController` for session start | `SessionController` | aborted by `dispose()` | every `await` in `start()` is followed by `checkpoint()`; abort → `SessionDisposedError` (silently ignored by the hook). |
| WebSocket / `RTCPeerConnection` | provider `connect()` | provider `disconnect()` via `ConversationRuntime.stop()` | reconnect timers are cleared in `disconnect()`. |
| Renderer (PIXI / three / canvas) | `createAvatarProvider` | `AvatarRuntime.dispose()` → `provider.stop()` | after the runtime, before the context. |
| Active session registry | `setActiveSession(controller)` in `start()` | `dispose()` / `pagehide` / App route change | belt-and-braces for cases where React cleanup did not run. |

## Teardown order (`SessionController.teardown()`)
1. `abort.abort()` — pending `start()` steps stop at their next checkpoint.
2. `BehaviorEngine.stop()` — no more provider calls.
3. `MicCapture.stop()` — **tracks stopped, tap disposed, source disconnected**.
4. `ConversationRuntime.stop()` — sink interrupted + stream detached, provider `disconnect()` (sockets/peer connections closed).
5. `AvatarRuntime.dispose()` — renderer stopped.
6. `SpeakerOutput.close()` — sources stopped, tap disposed, gain disconnected, **owned `AudioContext` closed**.

`end()` uses the same path after collecting the `SessionRecord`; `dispose()` is idempotent (memoised promise).

## Rules
- One `AudioContext` per session, shared by mic and speaker; created inside the user gesture that starts the session.
- Contexts are closed on End, on route change and on `pagehide`; never left `suspended`.
- Every async start step checks `disposed`/abort after awaiting; partially-created resources are released by the same teardown.
- `whenReady()` may reject on a live sink (worklet unsupported); a closed sink swallows the rejection.
- Dev / `?debug=1`: `window.__rcaiAudio.live()` must report `{ contexts: 0, tracks: 0 }` after teardown (`apps/web/scripts/lifecycle-stress.mjs` asserts this 100×).
