# Changelog

All notable changes to this project are documented here. Current release measurements and limits are summarized in [docs/validation.md](docs/validation.md); older entries below are historical development notes.

## [Unreleased]
### Changed
- **Visual foundation is now the Digital Agency Design System (DADS)** via the official `@digital-go-jp/design-tokens` package: colour, typography, elevation and line-height come from DADS tokens through a three-layer system (DADS token → `--app-*` application semantic token → component). No hand-invented "DADS-like" values: 0 raw hex outside `tokens.css`, 0 component references to DADS primitives.
- Type is Noto Sans JP (400/700 only) with the DADS size scale — 16px body, nothing below 14px anywhere; density is solved by removing information, not shrinking it.
- Colour budget: white/neutral surfaces carry the UI and DADS Blue `#0017C1` appears only on primary actions, selected state, focus, links and the home actions; providers have no colour; no gradients, glows or coloured cards. `pnpm contrast` audits every painted pair (text ≥ 4.5:1, UI ≥ 3:1) — 17/17 pass.
- **UI redesign — a room for a conversation, not a dashboard.** Information is now classified in three levels (`docs/ui-design.md`) and Level 2/3 never appears in Level 1: the conversation screen is the avatar, the character's name, the latest line and three controls; provider, latency, transcript, evaluation and developer tooling moved behind ···. `LISTENING/THINKING/SPEAKING` is no longer a permanent badge — the character shows it, with a faint whisper that fades after a glance (and stays readable for the gate runners).
- Home is one question and a few text answers plus a single continuation line; character selection became its own screen (one large character, neighbours either side); settings and setup became label→value rows with a 詳細設定 disclosure; the result screen leads with the score, a one-line reading and the single most useful fix, then discloses the detail.
- Visual system: near-white ground, one accent, hierarchy from spacing/typography/alignment. No cards, no nested boxes, no section backgrounds, no gradients or glows; shadow only on floating layers; radius only where a container exists. Motion 140/220/320 ms.
- A visually-hidden live transcript (`.sr-only`, `aria-live`) keeps the conversation available to screen readers and to the Reality-Gate runners now that only one line is on screen.
- Previous iteration (kept in history): the 稽古場の進行表 paper design: paper shell with ink type, hairline rules and a single 朱 accent; the session stage is now the only dark surface. Products became a numbered running order (ink-sweep hover) instead of a card grid; characters are name plates (結・春・玲・慧) instead of gradient blobs; emoji controls became typographic buttons.
- Japanese-first wording throughout: removed the 日本語/English double labels, translated persona parameter labels, renderer names, meeting/settings fields, evaluation metrics and `BLOCKED_BY_*` codes (raw codes kept in tooltips and reports).
- Typography: Zen Old Mincho (display) + Zen Kaku Gothic New (body) + IBM Plex Mono restricted to numerals and instrument readouts. Design rules documented in `docs/ui-design.md`.
- `soak-browser.mjs` matches the status pill by state word rather than prefix (the pill is now Japanese-first).

## [0.2.0-beta.1] — 2026-08-30 — Production Beta Candidate
First versioned build. Everything below was implemented and executed on 2026-08-30 (Gate 0–10, Round 2, Round 3).

### Conversation
- Provider-independent runtime: OpenAI Realtime (WebRTC), Gemini Live (WSS), fully Local (Silero VAD → SenseVoice incremental STT → llama.cpp → resident AVSpeech streaming TTS) behind `RealtimeAIProvider` + `ConversationEvent`.
- Generation Epoch (sessionId/turnId/generationId/sequence): late chunks after barge-in are dropped at runtime / avatar / UI (194 real barge-ins, 0 stale).
- Adaptive/semantic endpointing (Japanese completeness cues, adaptive silence): premature endpoint 29.5 % → 15.9 %; true speech end → first audio P50 878 ms (local).
- `privacyMode: strict_local` with process-level egress guard (verified `[]` in every run).
### Character
- Live2D (pixi-live2d-display + Cubism Core), 6-layer MotionStack, 36-clip library with no-repeat history, Behavior Engine (blink/gaze/breathing/listening nods, listener semantics — no smile on bad news), audio-driven lip sync (analyzer; MotionSync path implemented, Core required).
- VRM (three-vrm) provider; HeyGen LiveAvatar / Tavus cloud avatar adapters.
### Products
- Free Talk / Interview Practice / English Conversation with 13 personas; evaluation sidecar with evidence-quoted criteria; Human 10-minute gate panel + presence incidents (media opt-in only); session observability.
- Meeting participation via Recall (`MeetingConnector`, participation policy, signed single-use bot-page tokens, lifecycle state machine).
### Tooling
- One-command Reality Gates `pnpm reality:{openai,gemini,local,meet,zoom,human}`; soak / acoustic / lifecycle / barge-in stress runners; license audit (`pnpm licenses`).
- Tauri desktop shell (signed with Developer ID; notarization pending credentials).

### Known limitations (see `docs/acceptance-gates.md` → Blocked items)
- Cloud engines, Recall meetings, MotionSync, notarization, Japanese streaming STT model, physical-mic gates are BLOCKED_BY_* until the external dependency is supplied.
- Local turn latency target 700 ms not yet reached (878 ms P50).
- Desktop app expects the local services (`pnpm dev` / `scripts/local-stack.sh`) to be running; sidecar bundling is not done.
