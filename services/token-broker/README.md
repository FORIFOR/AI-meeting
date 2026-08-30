# services/token-broker — credentials & cloud soak

The broker is the only process that ever sees cloud API keys (spec §26). Clients receive ephemeral
credentials (`/api/token/openai`, `/api/token/gemini`) and never the key itself.

## Setup
```bash
cp services/token-broker/.env.example services/token-broker/.env
# edit .env:
#   OPENAI_API_KEY=sk-...        → enables OpenAI Realtime (gpt-realtime, WebRTC)
#   GEMINI_API_KEY=AIza...       → enables Gemini Live (ephemeral auth_tokens)
#   LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET   (optional; LiveKit rooms)
#   HEYGEN_API_KEY / HEYGEN_AVATAR_ID, TAVUS_API_KEY / TAVUS_REPLICA_ID / TAVUS_PERSONA_ID (optional; realistic avatars)
pnpm --filter @rcai/token-broker start          # http://localhost:8787
curl -s http://localhost:8787/health             # {"ok":true,"providers":{"openai":true,"google":true,...}}
```
`/health` reports a provider as available only when its key is configured; otherwise token routes answer
`503 {"error":"BLOCKED_BY_OPENAI_KEY"}` / `BLOCKED_BY_GEMINI_KEY`, and the web app shows the code as a toast.

## 30-minute soak per engine (P0-2)
Prerequisites: `pnpm dev` (web 5173 + broker 8787 + agent 8788) — for `local` also `scripts/local-stack.sh start`.
```bash
node apps/web/scripts/soak-browser.mjs --engine openai --minutes 30 --mode free_talk --character yui
node apps/web/scripts/soak-browser.mjs --engine google --minutes 30 --mode free_talk --character yui
node apps/web/scripts/soak-browser.mjs --engine local  --minutes 30 --mode free_talk --character yui
```
The harness drives the real web app in headless Chrome with a generated Japanese fake-microphone WAV
(`apps/web/scripts/lib/make-soak-wav.mjs`: statements, questions, a barge-in every 5th turn, 4–8 s gaps, loop-safe),
and writes `docs/reports/soak/<engine>-<timestamp>.{json,md}` with: turns, answered ratio, turn latency p50/p95,
barge-in stop, listening reaction, mouth stop, reconnect events, toasts/errors, longest silence, reply length
stats, result-screen score. Verdict `PASS` only if the session survived the full duration, ≥ 80 % of utterances were
answered and no fatal error occurred. Without a key the run exits with code 2 and the markdown says
`BLOCKED_BY_OPENAI_KEY` / `BLOCKED_BY_GEMINI_KEY` — it never fakes a pass.

What each soak proves (checklist from P0-2): connection · audio input (fake mic → provider) · native audio output
(assistant speech episodes + HUD mouth/lip activity) · transcript (captions) · barge-in (HUD `barge-in stop`) ·
reconnect (console `reconnecting` / `session_ready` events; providers retry ×3 with backoff) · session longevity
(survived N minutes, longest gap) · Japanese conversation (reply length stats, transcript excerpt).
