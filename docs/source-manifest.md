# Source manifest (single source of truth for external references)

Updated: 2026-08-30

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
