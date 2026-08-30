# Gate 0 — Repository audit (2026-08-30)

## Findings
- `~/Projects/AI-meeting` was **empty** at start (no code, no git). Nothing to reuse inside the repo.
- Reusable assets found *outside* the repo on this machine:
  - `~/Projects/sherpa-onnx-shared/models/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01` (Japanese ASR, INT8)
  - `~/Library/Application Support/DeepNote/models/` — `gemma-4-E2B-it-Q4_K_M.gguf` (llama.cpp LLM), `whisper-eval/ggml-kotoba-whisper-v2.0.bin`, sense-voice sherpa-onnx models
  - brew: `llama-server`, `whisper-server`, `ffmpeg`, `sox`; macOS `say` (dev TTS)
- Live2D: no Cubism Core / MotionSync Core / character models on disk. Official Core CDN reachable. Sample models available in `reference/CubismWebSamples` (Live2D Free Material License).
- Credentials: `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `LIVEKIT_*`, `TAVUS_API_KEY`, `HEYGEN_API_KEY` are **not set** in the shell environment.
- Tooling: Node 25.2.1, pnpm 10.12.2, cargo 1.93.1 (Tauri desktop shell possible), Codex CLI 0.144.3.

## Baseline tests
Before this work: none (empty repo). After scaffolding contracts: `pnpm test` → see `docs/acceptance-gates.md` evidence log.

## Gap analysis (spec §30 MVP vs. repo)
| Area | Status at audit | Plan |
|---|---|---|
| Contracts (§3, §4, §7, §8, §10, §18, §21) | absent | `packages/*` (Gate 1) |
| Live2D runtime (§9–§14) | absent; MotionSync Core unavailable | `avatar-providers/live2d` via pixi-live2d-display + Core CDN; lip sync via analyzer; MotionSync adapter slot (Gate 2) |
| OpenAI Realtime (§4) | absent; no key | WebRTC adapter + token broker (Gate 3) — device test BLOCKED_BY_OPENAI_KEY |
| Gemini Live (§5) | absent; no key | WSS adapter + ephemeral token (Gate 4) — device test BLOCKED_BY_GEMINI_KEY |
| Local (§6) | tools present | agent service: VAD→sherpa-onnx/whisper→llama.cpp→say/SBV2 (Gate 5) |
| Behavior engine (§11–§15) | absent | `packages/behavior-engine` (Gate 6) |
| Personas / modes (§18–§20) | absent | `personas/*`, `apps/web` (Gate 7) |
| Evaluator (§21) | absent | `services/evaluation` (Gate 8) |
| VRM / realistic (§16–§17) | absent; no keys | `avatar-providers/vrm` real; liveavatar/tavus adapters BLOCKED_BY_*_KEY (Gate 9) |
