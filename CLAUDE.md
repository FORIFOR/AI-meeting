# Realtime Character AI Platform — repository rules

Read `docs/source-manifest.md`, `docs/architecture.md` and `docs/acceptance-gates.md` before changing architecture.
The spec is `docs/spec-v1.md`; release measurements and limits are in `docs/validation.md`.

## Absolute rules
1. UI code never binds directly to OpenAI, Gemini, llama.cpp, Live2D or an avatar vendor. Only `@rcai/*` contracts.
2. Every conversational provider implements `RealtimeAIProvider` (`packages/provider-core`).
3. Every avatar implements `AvatarProvider` (`packages/avatar-core`).
4. Provider-native events are translated to `ConversationEvent` (`packages/conversation-core`). Nothing else crosses the boundary.
5. Avatar state is driven only by normalized events: IDLE / LISTENING / THINKING / SPEAKING / INTERRUPTED / REACTING.
6. Audio that actually reaches the speaker (`SpeakerOutput.tap`) is the source of truth for lip sync. Never TTS text.
7. User speech stops assistant audio, lip sync and speaking motion immediately (runtime fast path, no provider round trip).
8. Listening animation continues while the user talks; the avatar never freezes.
9. Semantic motion planning is asynchronous and never delays audio playback.
10. Evaluator is a sidecar (`services/evaluation`) — never in the conversation latency path.
11. `privacyMode: "strict_local"` performs zero cloud transmission (`privacyGuard` in provider-core).
12. Never fake integrations. Missing SDK/credentials/models ⇒ `BLOCKED_BY_*` in `docs/acceptance-gates.md`, not a placeholder marked PASS.
13. Completion claims require executed tests / observable evidence, listed in `docs/acceptance-gates.md`.
14. Preserve existing behavior unless the goal changes it.

## Layout
`packages/*` contracts & engines · `providers/*` AI adapters · `avatar-providers/*` renderers · `services/*` node sidecars · `apps/web` UI · `characters/*` packs · `personas/*` · `reference/*` read-only study material (never a production dependency) · `vendor/live2d` human-supplied SDK files.

## Commands
`pnpm install` · `pnpm test` · `pnpm typecheck` · `pnpm build` · `pnpm gate` (all three) · `pnpm dev` (web + token-broker + agent).
