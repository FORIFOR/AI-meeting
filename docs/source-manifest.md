# Source manifest (single source of truth for external references)

Updated: 2026-09-12

## VRM local audio rendering and distribution

| Item | URL | Pinned use |
|---|---|---|
| three-vrm | https://github.com/pixiv/three-vrm | `@pixiv/three-vrm@3.5.5`, `three@0.185.1`, MIT |
| wLipSync | https://github.com/mrxz/wLipSync | `wlipsync@1.3.1`, source commit `73d0170f500c2845a62a8fe4384a4729499e8426`, MIT. WASM in a local Worker; calibration profile copied with its MIT notice. No extra audio playback or avatar API |
| Official VRM 1.0 sample | https://github.com/vrm-c/vrm-specification/tree/821c11b250d8c70d5804ee13431e42bee56ea9c0/samples/VRM1_Constraint_Twist_Sample | Unmodified file in `characters/vrm-sample`, SHA-256/source/embedded metadata preserved. VRM Public License 1.0 and model permissions, separate from code license |
| AvatarSample_A | https://hub.vroid.com/characters/2843975675147313744/models/5644550979324015604 | Official current distribution is VRM 0.0; not silently relabeled as VRM 1.0 or bundled from an unverified mirror. Local import supported |

Distribution/source audit: [application license and component exceptions](../NOTICE). Local Anam portrait experiments are not an authorization to upload Live2D sample-derived images to an external renderer.

## Anam optional synchronized renderer

| Item | URL | Status in this repo |
|---|---|---|
| Audio Passthrough | https://anam.ai/docs/javascript-sdk/examples/custom-tts | `@anam-ai/js-sdk@4.27.0`, external PCM only, server-only API key; real account validation blocked by missing key/avatar mapping |
| Session token | https://anam.ai/docs/api-reference/sessions/create-session-token | `/api/avatar/anam/session`, Cara-4, replay disabled, validated server character→avatar mapping |
| Events | https://anam.ai/docs/javascript-sdk/reference/events | No guaranteed passthrough returned-AV EOF; same-session cancellation resumption is not implemented |
| Custom avatar image | https://anam.ai/docs/personas/avatars/custom-avatar-best-practices | Square 1152px minimum, <=4.5MB. Local portrait authoring tool; no external image registration performed |

## Live2D (proprietary parts must be supplied by a human)
| Item | URL | Status in this repo |
|---|---|---|
| Cubism SDK for Web (Core `live2dcubismcore.min.js`) | https://www.live2d.com/en/sdk/download/web/ | Loaded from the official CDN `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` (permitted by Live2D for web use) unless `vendor/live2d/live2dcubismcore.min.js` exists (`scripts/fetch-live2d-core.sh`). strict_local requires the vendored copy (no CDN egress). |
| Cubism SDK for Native | https://www.live2d.com/en/sdk/download/native/ | Not used by the web app (desktop Native path is future work). |
| MotionSync Plugin (Web/Native) | https://www.live2d.com/en/sdk/download/motionsync/ | **BLOCKED_BY_MOTIONSYNC_CORE** — `live2dcubismmotionsynccore.min.js` is not on GitHub or CDN. Place at `vendor/live2d/live2dcubismmotionsynccore.min.js`. Lip sync falls back to `@rcai/avatar-core` `AnalyzerLipSync` (audio-driven, formant heuristic). |
| Cubism Web Framework | https://github.com/Live2D/CubismWebFramework | `reference/CubismWebFramework` (study) |
| Cubism Web Samples (Hiyori/Haru/… sample models, Live2D Free Material License) | https://github.com/Live2D/CubismWebSamples | `reference/CubismWebSamples`; `scripts/fetch-sample-character.sh` copies a sample into `characters/sample/model` (git-ignored). |
| Cubism Web MotionSync Components | https://github.com/Live2D/CubismWebMotionSyncComponents | `reference/CubismWebMotionSyncComponents` (Core missing) |
| SDK manual | https://docs.live2d.com/en/cubism-sdk-manual/top/ | — |
| MotionSync manual (Web) | https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-motionsync-plugin-for-web/ | — |
| pixi-live2d-display (MIT wrapper used by `avatar-providers/live2d`) | https://github.com/guansss/pixi-live2d-display | npm `pixi-live2d-display@0.4.0` + `pixi.js@6` |

## Realtime AI APIs
| Item | URL |
|---|---|
| OpenAI Realtime (WebRTC, ephemeral client secrets) | https://platform.openai.com/docs/guides/realtime-webrtc |
| OpenAI Realtime events | https://platform.openai.com/docs/api-reference/realtime-client-events |
| Gemini Live API | https://ai.google.dev/gemini-api/docs/live |
| Gemini Live ephemeral tokens | https://ai.google.dev/gemini-api/docs/ephemeral-tokens |
| Gemini Live capabilities (VAD, affective dialog, proactive audio) | https://ai.google.dev/gemini-api/docs/live-guide |

## Transport / agent framework
| Item | URL | Status |
|---|---|---|
| LiveKit Agents | https://github.com/livekit/agents | `reference/agents` (provider abstraction studied; product is not coupled to LiveKit) |
| LiveKit Agents docs | https://docs.livekit.io/agents/ | — |
| LiveKit Docs MCP | https://docs.livekit.io/mcp | registered: `claude mcp add --transport http livekit-docs https://docs.livekit.io/mcp` |
| LiveKit coding agent support | https://docs.livekit.io/intro/coding-agents/ | — |
| livekit-client (browser) | https://www.npmjs.com/package/livekit-client | used by `avatar-providers/liveavatar`, `avatar-providers/tavus` |

## Local speech / AI
| Item | URL | Status on this machine |
|---|---|---|
| sherpa-onnx | https://github.com/k2-fsa/sherpa-onnx | `sherpa-onnx-node` npm; Japanese models present (`~/Projects/sherpa-onnx-shared/models`, DeepNote models dir) |
| Silero VAD | https://github.com/snakers4/silero-vad | `reference/silero-vad`; ONNX model usable via sherpa-onnx VAD |
| whisper.cpp | https://github.com/ggml-org/whisper.cpp | `whisper-server` (brew) + `ggml-kotoba-whisper-v2.0.bin` |
| llama.cpp | https://github.com/ggml-org/llama.cpp | `llama-server` (brew) + `gemma-4-E2B-it-Q4_K_M.gguf` |
| MLX-LM | https://github.com/ml-explore/mlx-lm | not installed (OpenAI-compatible adapter covers `mlx_lm.server`) |
| Style-Bert-VITS2 | https://github.com/yonenn/Style-Bert-VITS2 | **BLOCKED_BY_SBV2_SERVER** (HTTP adapter implemented; server not installed). Dev fallback: macOS `say` adapter. |
| Ollama / vLLM | https://ollama.com , https://github.com/vllm-project/vllm | OpenAI-compatible adapter |

## 3D / realistic avatars
| Item | URL | Status |
|---|---|---|
| three-vrm | https://github.com/pixiv/three-vrm | npm `@pixiv/three-vrm@3` + `three` |
| ChatVRM (archived, reference only) | https://github.com/pixiv/ChatVRM | `reference/ChatVRM` — never a dependency |
| HeyGen LiveAvatar (Streaming API) | https://docs.heygen.com/docs/streaming-api | **BLOCKED_BY_HEYGEN_KEY** |
| Tavus CVI | https://docs.tavus.io/sections/conversational-video-interface/cvi-overview | **BLOCKED_BY_TAVUS_KEY** |
