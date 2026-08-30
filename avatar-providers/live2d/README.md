# @rcai/avatar-live2d

Live2D (Cubism 4) implementation of `AvatarProvider`, built on `MotionStackAvatarBase`
(`@rcai/avatar-core`) + `pixi.js@6` + `pixi-live2d-display@0.4.0`.

```ts
const avatar = new Live2DAvatarProvider({ container: stageEl });
await avatar.prepare(await loadCharacter("/characters/yui"));
await avatar.start();
speaker.tap.subscribe((f) => avatar.pushAudio(f)); // played PCM → lip sync
```

## Proprietary parts
| Piece | How it is obtained | Missing ⇒ |
|---|---|---|
| Cubism Core `live2dcubismcore.min.js` | `vendor/live2d/` if present, else the official CDN `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` | provider throws at `prepare()` |
| MotionSync Core `live2dcubismmotionsynccore.min.js` | must be downloaded from https://www.live2d.com/en/sdk/download/motionsync/ into `vendor/live2d/` | `MotionSyncLipSync.create()` throws `MotionSyncUnavailableError` (`BLOCKED_BY_MOTIONSYNC_CORE`); provider falls back to `AnalyzerLipSync` (audio-driven formant heuristic) and reports it in `diagnostics.blocked` |
| Character model | `scripts/fetch-sample-character.sh` (Live2D sample models, Free Material License, dev only) | 404 at `prepare()` |

## Driving model
The library's idle motion, eye blink, breath, focus and lip sync are disabled; every frame the
MotionStack output is written via `coreModel.setParameterValueById` in `beforeMotionUpdate`
(before expression/physics/pose), so physics and `.exp3.json` expressions still apply on top.
Canonical → Live2D ids come from `LIVE2D_PARAM_IDS` + `character.paramIds`; models without
`ParamMouthOpenY` (e.g. sample "Mao") get `ParamA/I/U/E/O` derived from open/form.

## Demo
`pnpm --filter @rcai/avatar-live2d demo` → http://localhost:5180/?character=yui

## MotionSync (spec §14 primary path) — implemented, Core-gated

`src/motionsync/` is a self-contained TypeScript port of Live2D's *CubismWebMotionSyncComponents* framework
(Live2D Open Software License — see `reference/CubismWebMotionSyncComponents/LICENSE.md`; only the parts that
talk to the Core: engine init, CRI processor, mapping-info marshalling, analysis result, `.motionsync3.json`
parsing, smoothing/damping). `MotionSyncLipSync` (`src/motionSync.ts`) implements `LipSyncEngine` on top of it:
played PCM → `push()` → Core analysis at the setting's fps → parameter values written to the model
(`ParamMouthOpenY/Form` or `ParamA/I/U/E/O`) and mirrored into `LipSyncOutput`.

| Option `lipSyncEngine` | Behaviour |
|---|---|
| `"auto"` (default) | MotionSync when `/vendor/live2d/live2dcubismmotionsynccore.min.js` exists **and** the model references a `.motionsync3.json`; otherwise `AnalyzerLipSync` + `diagnostics.blocked = ["BLOCKED_BY_MOTIONSYNC_CORE"]` |
| `"motionsync"` | required — `prepare()` rejects with `MotionSyncUnavailableError` (`code: BLOCKED_BY_MOTIONSYNC_CORE`) |
| `"analyzer"` | never tries MotionSync |

To unblock: download the **Cubism MotionSync Plugin for Web** (https://www.live2d.com/en/sdk/download/motionsync/),
copy `Core/live2dcubismmotionsynccore.min.js` to `vendor/live2d/`, and use a model with a `.motionsync3.json`
(`characters/kei` = Live2D sample *Kei_basic*, fetched by `scripts/fetch-sample-character.sh`).
The Core API surface the port expects is declared in `src/motionsync/coreApi.ts`; `src/motionsync.test.ts`
exercises the whole path against a fake Core.

### Lip-sync A/B harness
```bash
tools/lipsync-corpus/build.sh                     # 64 Japanese sentences × normal/fast/quiet (say -v Kyoko)
pnpm --filter @rcai/avatar-live2d demo            # demo server on :5180
node demo/ab-run.mjs --engine analyzer            # → docs/reports/lipsync/analyzer-<ts>.{json,md}
node demo/ab-run.mjs --engine motionsync --character kei
pnpm exec tsx tools/lipsync-corpus/offline-eval.ts # analyzer only, no browser (vowel-class form differentiation)
```
