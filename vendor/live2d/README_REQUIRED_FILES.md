# vendor/live2d — human-supplied Live2D runtime files (never committed)

| File | Source | Purpose | If missing |
|---|---|---|---|
| `live2dcubismcore.min.js` | Cubism SDK for Web package — https://www.live2d.com/en/sdk/download/web/ | Cubism Core runtime (offline / self-hosted) | `@rcai/avatar-live2d` falls back to the official CDN `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` |
| `live2dcubismmotionsynccore.min.js` | Cubism MotionSync Plugin for Web — https://www.live2d.com/en/sdk/download/motionsync/ | MotionSync lip sync core | **BLOCKED_BY_MOTIONSYNC_CORE** — provider uses `AnalyzerLipSync` (audio-driven formant heuristic) |

Character models (`.moc3`, textures, `.model3.json`, optional `.motionsync3.json`) go to `characters/<id>/model/`
(see `scripts/fetch-sample-character.sh` for the Live2D sample models used in development).

Respect the Live2D Proprietary Software License / Open Software License and the sample model terms.
