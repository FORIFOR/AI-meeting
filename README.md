# Realtime Character AI Platform

Provider-independent realtime character conversation platform: **OpenAI Realtime / Google Gemini Live / fully Local** ⇄ **Live2D (primary) / VRM / realistic cloud avatars**, for interview practice, English conversation, sales roleplay, tutoring and free talk.

- Spec: `docs/spec-v1.md` · Execution pack: `claude_code_avatar_implementation_pack.md`
- Architecture: `docs/architecture.md` · Contracts: `docs/integration-contracts.md`
- External sources: `docs/source-manifest.md` · Gate evidence: `docs/acceptance-gates.md` · Reports: `docs/reports/`

## Quick start
```bash
pnpm install
scripts/fetch-sample-character.sh          # copies Live2D sample models (Free Material License) into characters/*/model
scripts/fetch-live2d-core.sh               # self-hosts Cubism Core (required for strict_local; otherwise the official CDN is used)
cp services/token-broker/.env.example services/token-broker/.env   # add OPENAI_API_KEY / GEMINI_API_KEY (optional)
scripts/local-stack.sh start               # optional: llama-server (+ builds tools/tts-daemon, the resident AVSpeech streaming TTS) for the Local provider
pnpm dev                                   # web (5173) + token-broker (8787) + agent (8788)
```
Open http://localhost:5173.

## Gates
`pnpm gate` = typecheck + tests + web build. See `docs/acceptance-gates.md` for what has real evidence and what is `BLOCKED_BY_*`.

One-command Reality Gates (exit 2 + `BLOCKED_BY_*` when a credential is missing — never a faked PASS):
```bash
pnpm reality:local     # 10-min fully local soak (strict_local) — runnable now
pnpm reality:openai    # 30-min real OpenAI Realtime soak   (needs OPENAI_API_KEY)
pnpm reality:gemini    # 30-min real Gemini Live soak       (needs GEMINI_API_KEY)
pnpm reality:meet      # join a real Google Meet via Recall (needs RECALL_API_KEY, RECALL_PUBLIC_URL, RECALL_BOT_PAGE_URL, MEET_URL)
pnpm reality:zoom      # same for Zoom (ZOOM_URL)
pnpm reality:human     # starts the stack + opens the app for the 10-minute human gate
```

Evidence runners (real Chrome, headless):
- Live2D character + lip sync: `pnpm --filter @rcai/avatar-live2d demo` then `node avatar-providers/live2d/demo/verify.mjs`
- Local agent E2E (strict_local, VAD→STT→LLM→TTS, barge-in, egress check): `scripts/local-stack.sh start && pnpm --filter @rcai/agent start`, then `cd services/agent && pnpm exec tsx scripts/e2e-local.ts`
- Full web app with a fake microphone WAV: `node apps/web/scripts/e2e-browser.mjs <mic.wav>` (stack + `pnpm dev` running)
- 30-minute soak per engine (real credentials for cloud): `node apps/web/scripts/soak-browser.mjs --engine local|openai|google --minutes 30`
- Real-device acoustic gate (BlackHole loopback or a real mic): `node apps/web/scripts/acoustic-gate.mjs <utter1.wav> <utter2.wav>`
- Local latency breakdown (VAD / STT / LLM TTFT / first phrase / TTS TTFA): `cd services/agent && pnpm exec tsx scripts/e2e-local.ts`
- Lip-sync corpus A/B (analyzer vs MotionSync): `tools/lipsync-corpus/build.sh && node avatar-providers/live2d/demo/ab-run.mjs --engine analyzer`
- Google Meet / Zoom participation (Recall): `MEET_URL=… pnpm --filter @rcai/connector-recall e2e:meet` (needs `RECALL_API_KEY` + public tunnel URLs)
- Human 10-minute gate: `docs/human-gate.md` (one-tap observation panel inside the session)
- Contrast audit (DADS tokens, WCAG): `pnpm contrast`
- License audit: `pnpm licenses` → `licenses.json`, `THIRD_PARTY_NOTICES.md` (curated exceptions in `NOTICE.md`)

## Layout
```
apps/web            React UI (never imports vendor SDKs)
packages/*          contracts & engines (audio, conversation, provider, avatar, behavior, persona)
providers/*         openai · gemini · local  → RealtimeAIProvider
avatar-providers/*  live2d · vrm · canvas(debug) · liveavatar · tavus → AvatarProvider
services/*          token-broker · agent (local bus) · evaluation (sidecar)
characters/*        yui · reina · haru packs        personas/*   interview · english · sales · tutor · free_talk · career
reference/*         read-only study repos (git-ignored)   vendor/live2d  human-supplied SDK files
```
