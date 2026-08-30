# Changelog

All notable changes to this project are documented here. Evidence for every gate lives in `docs/acceptance-gates.md` and `docs/reports/`.

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
