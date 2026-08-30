# Gate 2 (Live2D character) / Gate 3 (audio-driven lip sync) — report (Fork A, 2026-08-30)

## Verdict
- **Gate 2 — PASS**: three Live2D sample models (Hiyori/Haru/Mao) render in real Chrome 152 (headless, ANGLE/SwiftShader WebGL) and move through IDLE → LISTENING → THINKING → SPEAKING → INTERRUPTED → LISTENING driven only by `ConversationEvent` → `AvatarRuntime` → `MotionStackAvatarBase`.
- **Gate 3 — PASS (AnalyzerLipSync path)**: the mouth follows PCM that is actually played through `SpeakerOutput` (AudioContext running, audio clock advanced 1.27 s during sampling), max `mouthOpenY` 0.95, `mouthForm` swings −0.96…+0.24 across the vowel sequence; on interrupt the mouth goes 0.448 → 0 in 0.2 ms (same tick) and stays 0 for the next 500 ms, speaking clip cut, state → LISTENING.
- **BLOCKED_BY_MOTIONSYNC_CORE**: Live2D MotionSync (the spec's primary lip-sync path) cannot run — `live2dcubismmotionsynccore.min.js` is proprietary and absent from GitHub/CDN/`vendor/live2d`. `MotionSyncLipSync.create()` throws `MotionSyncUnavailableError` and the provider records the block in `diagnostics.blocked`. Lip sync currently uses the audio-driven formant analyser (`AnalyzerLipSync`), still real played audio, never TTS text.
- Claude-in-Chrome extension was **not connected** in this session (tool reported "Browser extension is not connected"), so verification used real Google Chrome via `puppeteer-core` headless (`avatar-providers/live2d/demo/verify.mjs`). Same browser engine; screenshots + JSON evidence below. Manual eyes-on check in a headed browser is still recommended for Gate B (10-min observation).

## Evidence
Runner: `cd avatar-providers/live2d && pnpm demo` (background) then `node demo/verify.mjs` → `docs/reports/img/gate2-results.json`.

| Check | Result |
|---|---|
| Model render (yui/Hiyori, haru/Haru, reina/Mao) | `docs/reports/img/gate2-{yui,haru,reina}-idle.png`; parameterCount 70 / 42 / 132; core loaded from official CDN (`vendor/live2d` absent → 404 HEAD → CDN fallback as designed); no page errors |
| LISTENING motion over 3.9 s (30 ms sampling) | state=LISTENING, clip `listen_interested`; angleY range 2.78°, angleX 1.08°, bodyAngleX 0.93°, eyeBallX 0.18; blink captured (eyeLOpen 0.14 in `gate2-yui-listening-1.png`, 1.0 in `-2.png`) |
| SPEAKING with real audio (`SpeakerOutput.tap → provider.pushAudio`) | AudioContext `running`, clock +1.27 s; 30/31 samples mouthOpenY > 0.2, max 0.955; mouthForm range [−0.955, +0.235]; `gate3-yui-speaking.png` |
| INTERRUPT mid-audio | before 0.448 → after 0.000 in 0.2 ms; next 10 samples (500 ms) all 0; `stack.isSpeaking=false`, speech clip null, `speaker.isPlaying=false`, state LISTENING; `gate3-yui-interrupted.png` |
| Unit tests | `pnpm vitest run avatar-providers/live2d avatar-providers/canvas characters` → 8 tests pass (core URL precedence, param mapping/clamping/viseme fallback, canvas provider tick+interrupt, three character packs validate) |
| Typecheck | `pnpm --filter @rcai/avatar-live2d --filter @rcai/avatar-canvas --filter @rcai/characters typecheck` → Done |

## Files
- `scripts/fetch-sample-character.sh` — copies Hiyori/Haru/Mao (+ license notice) into `characters/{yui,haru,reina}/model/` (git-ignored via `characters/.gitignore`). Executed.
- `characters/` — `index.ts` (registry), `.gitignore`, `tsconfig.json`, `characters.test.ts`, `{yui,haru,reina}/{manifest.json,character.json,model/README.md}`. reina uses `paramIds` overrides (`ParamA`, `ParamMouthUp`, `ParamArmLA01`, …) because Mao has no `ParamMouthOpenY`; haru maps `laugh→F05`, `surprised→F06` exp3 files; reina maps `smile/laugh/serious/sad → exp_04/02/05/07`.
- `avatar-providers/live2d/src/` — `core.ts` (Core URL precedence option → vendor → CDN, script loader), `mapping.ts` (canonical → Live2D ids, model-range clamp, ParamA/I/U/E/O + MouthUp/Down derivation), `motionSync.ts` (BLOCKED slot), `live2dAvatar.ts` (provider; library idle/blink/breath/focus/lipSync disabled; params written in `beforeMotionUpdate` so exp3 expressions + physics + pose still apply), `live2d.test.ts`, `README.md`.
- `avatar-providers/live2d/demo/` — `index.html`, `main.ts` (state/emotion/gesture buttons, vowel synth through `SpeakerOutput`, overlay, `window.__rcai`), `vite.config.ts` (serves `/characters` and `/vendor` from repo root), `verify.mjs` (evidence runner). `package.json`: added script `demo`, devDeps `vite`, `puppeteer-core@25.9.0`, `@rcai/behavior-engine`, `@rcai/conversation-core` (via `pnpm add … --filter @rcai/avatar-live2d`; lockfile updated).
- `avatar-providers/canvas/` — `CanvasAvatarProvider` DEV/DEBUG renderer (captioned "DEBUG RENDERER"), README, jsdom test.
- `vendor/live2d/README_REQUIRED_FILES.md`.
- `docs/reports/img/*.png`, `gate2-results.json`.

## Notes / out of scope
- Root `vitest.config.ts` also picks up `apps/web/public/characters/characters.test.ts` through the symlink (tests run twice). Root config is out of my scope; exclude `apps/web/public/**` there.
- Live2D sample models are Free Material License (dev only); production characters must be replaced.
- Layout uses `character.view` (scale/y) for upper-body framing; `Live2DAvatarProvider.diagnostics` exposes core source, lipsync engine, blocked list and missing canonical params (e.g. Haru lacks `ParamCheek`/`ParamShoulder`, skipped safely).
