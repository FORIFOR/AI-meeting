# P0-1 — MeetingConnector + Recall (Google Meet / Zoom) — 2026-08-30

**Status: CODE + TESTS PASS · real Google Meet gate BLOCKED_BY_RECALL_KEY (+ BLOCKED_BY_RECALL_PUBLIC_URL)**
No mock was marked PASS. The harness exits `2` with `BLOCKED_BY_RECALL_KEY` on this machine.

## Files
- `packages/meeting-core/src/{types,addressDetector,participationPolicy,index}.ts`, `meeting-core.test.ts` (25 tests): `MeetingConnector`/`MeetingSession`/`MeetingEvent` contract, `detectPlatform`, `AddressDetector` (JP/EN), `ParticipationPolicy` (OBSERVING→LISTENING→ADDRESSED→RESPONDING, cooldown, consecutive cap, proactivity addressed_only/invited/active, self-transcript ignored).
- `connectors/recall/src/{protocol,RecallConnector,botPage,index}.ts`, `recall.test.ts` (9 tests), `scripts/e2e-meet.ts` (harness), `package.json`, `tsconfig.json`; `pnpm-workspace.yaml` (+`connectors/*`).
- `services/token-broker/src/routes/meeting.ts` (create/retrieve/leave/output_audio), `src/meeting-relay.ts` (RelayHub), `src/server.ts` (ws upgrade: `/api/meeting/recall/relay/{token}/` ← Recall, `/api/meeting/recall/client/{botId}` → browser), `src/app.ts` (+5 routes, `/health.meeting`), `src/env.ts`, `.env.example`, `app.test.ts` (+3 tests), `package.json` (+ws).
- `apps/web/src/session/MeetingSessionController.ts`, `apps/web/src/screens/Meeting.tsx`, `apps/web/src/integrations/registry.ts` (`createMeetingConnector`), `apps/web/src/App.tsx` (meeting screen + bot-page detection `?rcai_bot=1`), `apps/web/src/screens/Home.tsx` (4th card 「会議に参加」), `apps/web/package.json`.
- `docs/integration-contracts.md` (Meeting section), this report.

## Commands & results
- `pnpm --filter @rcai/meeting-core --filter @rcai/connector-recall --filter @rcai/token-broker --filter @rcai/web typecheck` → all Done
- `pnpm vitest run` (whole repo) → **23 files / 178 tests passed** (was 124; nothing broken; strict_local tests intact)
- `pnpm --filter @rcai/web build` → ✓ built
- Live broker smoke (`PORT=8797`): `/health` → `meeting: { recall:false, recallPublicUrl:false, recallBotPageUrl:false, region:"us-west-2" }`; `POST /api/meeting/recall/bots` → **503 `{"error":"BLOCKED_BY_RECALL_KEY"}`**; ws `/api/meeting/recall/client/bot1` → open; ws `/api/meeting/recall/relay/not-a-token/` → **HTTP 401**; ws `/nope` → refused.
- `cd connectors/recall && pnpm exec tsx scripts/e2e-meet.ts` → `| credentials | BLOCKED | BLOCKED_BY_RECALL_KEY — set RECALL_API_KEY (broker .env) and re-run |`, exit 2.

## Recall.ai facts used (docs consulted 2026-08-30, not guessed)
- https://docs.recall.ai/docs/regions.md — base URLs `https://{us-east-1|us-west-2|eu-central-1|ap-northeast-1}.recall.ai`; `api.recall.ai` = us-east-1; keys are region-local.
- https://docs.recall.ai/reference/bot_create.md — `POST /api/v1/bot/` with `meeting_url`, `bot_name`, `recording_config`, `output_media`, `automatic_audio_output`, `metadata`, `join_at`, `variant`; header `Authorization: <API key>`.
- https://docs.recall.ai/docs/how-to-get-mixed-audio-real-time.md + real-time-websocket-endpoints.md + real-time-event-payloads.md — `recording_config.audio_mixed_raw: {}` + `realtime_endpoints: [{ type: "websocket", url: "wss://…", events: [...] }]`; payload `audio_mixed_raw.data` → `data.data.buffer` base64 **mono S16LE 16 kHz, 200 ms chunks**; `transcript.data` / `transcript.partial_data` → `data.data.words[].text` + `participant{id,name,is_host}`; `participant_events.{join,leave,speech_on,speech_off,…}`; retry 30×3 s; URL must end with `/` before query params; ping every 30 s to keep proxies alive.
- https://docs.recall.ai/docs/bot-real-time-transcription.md — `recording_config.transcript.provider.recallai_streaming: { mode: "prioritize_low_latency", language_code }`.
- https://docs.recall.ai/docs/stream-media.md (Output Media) — **the agent path**: `output_media.camera = { kind: "webpage", config: { url } }` (or `screenshare`); the bot runs the page, grants `getUserMedia` (meeting audio) without a prompt, streams the page's audio+video into the meeting; transcripts inside the bot via `wss://meeting-data.bot.recall.ai/api/v1/transcript`; localhost is blocked inside the bot → public tunnel required (docs/local-webhook-development.md).
- https://docs.recall.ai/docs/output-audio-in-meetings.md + reference/bot_output_audio_create.md — short clips only: `POST /api/v1/bot/{id}/output_audio/ { kind: "mp3", b64_data }` (mp3 only; needs `automatic_audio_output` configured). **Raw PCM streaming via REST is not supported** — streaming audio out is only possible through Output Media (webpage). Hence the connector's default mode is `output_media`.
- https://docs.recall.ai/docs/bot-status-change-events.md + reference/bot_retrieve.md — status codes `joining_call, in_waiting_room, in_call_not_recording, recording_permission_allowed/denied, in_call_recording, call_ended, done, fatal` (`status_changes[]`); reference/bot_leave_call_create.md — `POST /api/v1/bot/{id}/leave_call/`.

## Design
- Contract: UI and ConversationRuntime depend only on `@rcai/meeting-core`; Recall lives behind `@rcai/connector-recall` + broker (API key server-side only).
- **output_media mode** (default): operator UI creates the bot; the bot streams `RECALL_BOT_PAGE_URL/?rcai_bot=1&…`; that page (same web app, bot mode) runs the full pipeline: meeting audio → `ParticipationPolicy` gate → `ConversationRuntime` (OpenAI/Gemini/Local via public broker/agent) → `SpeakerOutput` (= meeting audio) + Live2D (= bot camera). When addressed, the addressing utterance (+ last 12 transcript lines) is sent to the AI as a hidden text turn, so any provider answers what it was asked; live audio is forwarded only while ADDRESSED/RESPONDING (barge-in/follow-ups), never while OBSERVING.
- **relay mode**: realtime events relayed through the broker (token-validated ws) to the local browser which runs the conversation; audio out = MP3 clips (`mp3Encoder` hook; `BLOCKED_BY_MP3_ENCODER` when absent — Recall does not accept WAV).
- Avatar keeps LISTENING micro-motion from local energy VAD / speech events while observing (never frozen), and returns to OBSERVING after `assistant_speech_ended` (policy `onAssistantDone`, cooldown 4 s, ≤2 consecutive responses).

## What the real Google Meet Reality Gate needs
1. `services/token-broker/.env`: `RECALL_API_KEY` (region account, e.g. ap-northeast-1 → `RECALL_REGION=ap-northeast-1`).
2. A public tunnel to the broker (`ngrok http 8787` → `RECALL_PUBLIC_URL=https://…`) and to the web app (`ngrok http 5173` → `RECALL_BOT_PAGE_URL=https://…`); for the Local engine the agent must also be reachable from the bot (tunnel + `agentUrl` in the bot page settings) or use OpenAI/Gemini.
3. A Google Meet link; then: web app → 「会議に参加」→ URL → Join (output_media). Evidence expected: status timeline joining→in_call, transcript with speaker names, policy OBSERVING→LISTENING→ADDRESSED on 「Yuiさん、どう思う？」→ RESPONDING → OBSERVING, audio audible in Meet, avatar visible as the bot's camera. Or run `MEET_URL=… pnpm --filter @rcai/connector-recall e2e:meet` for the relay-side table.

## BLOCKED_BY_*
| Key | Meaning |
|---|---|
| BLOCKED_BY_RECALL_KEY | no Recall API key on this machine |
| BLOCKED_BY_RECALL_PUBLIC_URL | no public tunnel for the broker / web page |
| BLOCKED_BY_MP3_ENCODER | relay-mode audio out needs an MP3 encoder (not added as a dependency) |
| BLOCKED_BY_STRICT_LOCAL | meetings are cloud by nature; refused under strict_local (tested) |
| zoom_native / google_native | contract ids reserved; not implemented (Recall covers Meet/Zoom/Teams/Webex) |


## 実会議テストの準備（2026-08-31）
鍵以外は準備済み。残りは Recall.ai の API キーのみ。

- `services/token-broker/.env` を作成（`RECALL_REGION=ap-northeast-1`、`MEETING_TOKEN_SECRET` はこの Mac 上で `openssl rand -hex 32` により生成、`RECALL_API_KEY` は空欄）。`.env` は git 管理外。
- `scripts/reality/meet-setup.sh`（`pnpm reality:meet:setup` / `:stop`）— cloudflared Quick Tunnel を broker と web に張り、URL を `.env` の `RECALL_PUBLIC_URL` / `RECALL_BOT_PAGE_URL` に自動で書き込み、トンネル越しの疎通を確認する。URL 抽出は実際に cloudflared を起動して検証済み。
- この経路のために直したもの:
  - `apps/web/vite.config.ts` — dev / preview の `allowedHosts` に `*.trycloudflare.com`（および ngrok、`RCAI_ALLOWED_HOSTS`）を追加。これが無いと Bot がトンネル経由でページを開けない（Vite が Host を拒否する）。
  - `services/token-broker/src/app.ts` — CORS に Bot ページの公開オリジン（`RECALL_BOT_PAGE_URL` のオリジン）を追加。Bot ページからブローカーへの `activate` 等が CORS で落ちるのを防ぐ。
  - `scripts/reality/lib.mjs` — すでに 5173 で dev サーバが動いていればそれを使う（トンネルが指す先と実際の配信元がずれないように）。
- 現状 `pnpm reality:meet` は `BLOCKED_BY_RECALL_KEY` で exit 2。**Google Meet / Zoom への実参加は未実施。**
