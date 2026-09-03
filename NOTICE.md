# NOTICE — specially licensed components

These are **not** plain MIT/Apache OSS. Each has its own terms that must be honoured before distribution.

| Component | Where | License / terms | Status |
|---|---|---|---|
| Live2D Cubism Core (`live2dcubismcore.min.js`) | `vendor/live2d/` (git-ignored) or official CDN | Live2D Proprietary Software License Agreement — https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html ; publishing requires the Live2D Open Software License terms for the framework and, for businesses above the revenue threshold, a Live2D publication license | not redistributed in repo |
| Live2D Cubism Web Framework / MotionSync Components | `reference/` (study), `avatar-providers/live2d` uses `pixi-live2d-display` (MIT) | Live2D Open Software License — https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html | framework not vendored |
| Live2D sample models Hiyori / Haru / Mao (`characters/{yui,haru,reina}/model`) | copied by `scripts/fetch-sample-character.sh` (git-ignored) | Live2D Free Material License — https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html (dev/demo use; replace with licensed characters before commercial release) | dev only |
| VRoid `AvatarSample_B.vrm` | `reference/ChatVRM/public` (not copied) | VRoid sample model terms (pixiv) — https://vroid.pixiv.help/ ; ChatVRM repo itself MIT | demo only |
| macOS speech voices (Kyoko etc.) via `say` / AVSpeechSynthesizer | local TTS fallback | Apple macOS Software License Agreement — audio generated may not be redistributed as a product voice | dev fallback |
| Style-Bert-VITS2 models / voices | `LOCAL_TTS=sbv2` (not bundled) | Style-Bert-VITS2 code AGPL-3.0 (server used over HTTP, not linked); each voice model has its own terms (JVNV corpus etc.) — verify per model at Character Voice registration (spec §6) | BLOCKED_BY_SBV2_SERVER |
| libvips prebuilt binaries (`@img/sharp-libvips-*`) | optional dependency of `sharp`, itself a dependency of `@huggingface/transformers` (agent uses only `WhisperFeatureExtractor`; no image model is ever loaded) | LGPL-3.0-or-later — weak copyleft: a shared library the user can replace; notice kept here, no modification, no static linking | ok (weak copyleft, notice kept) |
| sherpa-onnx / SenseVoice / ReazonSpeech zipformer / Silero VAD models | agent STT/VAD | sherpa-onnx Apache-2.0; SenseVoice model: FunAudioLLM Model License; ReazonSpeech: Apache-2.0; Silero VAD: MIT | ok (model licenses listed) |
| Gemma 4 (GGUF) via llama.cpp | local LLM | Gemma Terms of Use — https://ai.google.dev/gemma/terms ; llama.cpp MIT | ok for internal use; review for distribution |
| Cloud services: OpenAI Realtime, Google Gemini Live, HeyGen LiveAvatar, Tavus CVI, Recall.ai, LiveKit Cloud | providers/*, avatar-providers/*, connectors/* | respective Terms of Service; user data handling documented in `docs/spec-v1.md` §26 | per key |
| Google Fonts (Shippori Mincho, Zen Kaku Gothic, IBM Plex Mono) | `apps/web/index.html` | SIL Open Font License 1.1 | ok |
