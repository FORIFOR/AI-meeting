# P1 — Live2D MotionSync integration + lip-sync A/B + Japanese corpus (2026-08-30)

## Verdict
- **MotionSync path: implemented end-to-end, `BLOCKED_BY_MOTIONSYNC_CORE`** — the proprietary `live2dcubismmotionsynccore.min.js` is not in the repo, on GitHub or on a CDN. `node demo/ab-run.mjs --engine motionsync --character kei` stops with that code (`BLOCKED_BY_MOTIONSYNC_CORE`; report `docs/reports/lipsync/motionsync-2026-08-30T00-59-05.md`). Dropping the file at `vendor/live2d/live2dcubismmotionsynccore.min.js` and re-running is all that is needed; the whole port is exercised against a fake Core in `avatar-providers/live2d/src/motionsync.test.ts`.
- **AnalyzerLipSync (fallback, audio-driven) improved and measured on 192 corpus runs in real Chrome**: vowel-shape differentiation (wide i/e − narrow u/o mean `mouthForm`) **0.03 → 0.69**, coverage **89.3 % → 96.1 %** (小声 75.7 % → 93.8 %), close latency now measurable (237 ms) and stop latency 179 ms; interrupt still closes the mouth in the same tick (0.97 → 0.00 in 0.20 ms, max 0.000 in the following 600 ms).
- Whole repo: `pnpm vitest run` → 23 files / 181 tests passed; typecheck Done for `@rcai/avatar-core`, `@rcai/avatar-live2d`, `@rcai/characters`.

## Files
| Path | What |
|---|---|
| `avatar-providers/live2d/src/motionsync/coreApi.ts` | typed surface of the `Live2DCubismMotionSyncCore` global (as used by Live2D's framework) |
| `avatar-providers/live2d/src/motionsync/data.ts` | `.motionsync3.json` parser + mapping-info builder (port of CubismMotionSyncData/Json) |
| `avatar-providers/live2d/src/motionsync/engine.ts` | Core bindings: engine init, CRI processor, native marshalling of context config / mapping list / analysis config+result (port of EngineLib/EngineCri/ProcessorCRI/MappingInfoListMapper) |
| `avatar-providers/live2d/src/motionsync/cubismMotionSync.ts` | `CubismMotionSync` port (setSoundBuffer / updateParameters with smoothing+damping) on a structural `ParameterModel` |
| `avatar-providers/live2d/src/motionSync.ts` | `MotionSyncLipSync implements LipSyncEngine` — real implementation (was a stub); throws `MotionSyncUnavailableError` (code `BLOCKED_BY_MOTIONSYNC_CORE`) without the Core |
| `avatar-providers/live2d/src/live2dAvatar.ts` | `lipSyncEngine: "auto" \| "motionsync" \| "analyzer"`, `.motionsync3.json` discovery (model3 `FileReferences.MotionSync`), Core parameter writes applied in the same `beforeMotionUpdate` hook, closed when not speaking |
| `avatar-providers/live2d/src/motionsync.test.ts` | fake-Core test: parsing, engine/mapping marshalling, audio → parameter writes, LipSyncOutput, reset, BLOCKED error |
| `avatar-providers/live2d/demo/ab.html`, `ab-main.ts`, `ab-run.mjs`, `vite.config.ts` | A/B page + headless-Chrome runner (serves `/tools/*`, HMR off for stable long runs, retries) |
| `avatar-providers/live2d/README.md` | MotionSync + A/B documentation |
| `packages/avatar-core/src/lipsync.ts` | analyzer v2 (see below) |
| `packages/avatar-core/src/avatar-core.test.ts` | +2 tests (adaptive gain / idle decay), /u/ fixture adjusted |
| `tools/lipsync-corpus/corpus.json`, `build.sh`, `offline-eval.ts` | 64 tagged sentences, WAV synthesis (normal/fast/quiet), offline analyzer evaluation |
| `characters/kei/*`, `characters/index.ts`, `scripts/fetch-sample-character.sh` | Live2D MotionSync sample *Kei_basic* (ships `Kei_basic.motionsync3.json`) as character `kei`; script no longer deletes `model/README.md` |
| `docs/reports/lipsync/*` | raw run outputs |

## Commands run
```
pnpm vitest run avatar-providers/live2d            # 7 passed (3 mapping/core + 4 MotionSync fake-Core)
pnpm vitest run packages/avatar-core               # 16 passed
pnpm vitest run                                    # 23 files / 181 passed
pnpm --filter @rcai/avatar-live2d typecheck && pnpm --filter @rcai/avatar-core typecheck && pnpm --filter @rcai/characters typecheck
scripts/fetch-sample-character.sh                  # + Kei_basic → characters/kei/model
tools/lipsync-corpus/build.sh                      # 192 WAVs (41 MB, git-ignored)
pnpm exec tsx tools/lipsync-corpus/offline-eval.ts # form differentiation −0.01 (v1) → 0.74 (v2)
pnpm --filter @rcai/avatar-live2d demo             # :5180
node demo/ab-run.mjs --engine analyzer             # ×3: baseline 00-58-04, v2 01-07-54, v2+idle-decay 01-17-56
node demo/ab-run.mjs --engine motionsync --character kei   # → BLOCKED_BY_MOTIONSYNC_CORE
```

## Corpus (`tools/lipsync-corpus/corpus.json`)
64 sentences, `say -v Kyoko` 48 kHz: 母音 a/i/u/e/o rows (3 each, `vowelClass` open/wide/narrow), 促音 5, 拗音 5, 長音 5, 数字 6, 会社名 5, 英単語 5, 英日混在 5, 疑問文 5, 感情発話 6, 長文 2. Variants: normal, 早口 (`-r 260`), 小声 (−20 dB) → 192 runs per engine.

Metrics (per run, mouth sampled at rAF ≈ 60 Hz vs the played-audio envelope from `SpeakerOutput.tap`): coverage = voiced frames (> −42 dBFS) with `mouthOpenY` > 0.15; spurious = silent frames (< −58 dBFS for > 120 ms) with `mouthOpenY` > 0.1; open/close latency vs the envelope; stop = time to `mouthOpenY` < 0.02 after the last voiced frame; mean `mouthForm` over voiced frames (Live2D +1 wide / −1 pucker).

## Analyzer: before → after (real Chrome, Hiyori/yui, 192 runs each)
| run | coverage % | spurious % | open ms | close ms | stop ms | form wide / a / narrow | wide−narrow | interrupt |
|---|---|---|---|---|---|---|---|---|
| v1 baseline (00-58-04) | 89.3 | 1.5 | 13 | 190 | 16 | -0.78 / -0.65 / -0.81 | **0.03** | 0.66→0.00 in 0.60 ms |
| v2 bands+adaptive gain (01-07-54) | 95.6 | 4.4 | -2 | 288 | 9 | 0.54 / 0.52 / -0.18 | **0.72** | 0.85→0.00 in 0.20 ms |
| v2 + idle decay — final (01-17-56) | 96.1 | 5.7 | -1 | 237 | 179 | 0.54 / 0.52 / -0.16 | **0.69** | 0.97→0.00 in 0.20 ms |

What changed in `AnalyzerLipSync` (`packages/avatar-core/src/lipsync.ts`):
1. **Vowel shape** — the peak-per-band heuristic read every Kyoko vowel as "narrow" (fundamental harmonics dominate 250–550 Hz). Now band *energies* in dB relative to the 250–600 Hz region: `hi = max(1900–2800, 2800–4000) − low` (corpus: i −16 > a −18 > e −21 > u −24 > o −29 dB) → `mouthForm = clamp((hi+23)/5)`; `mid = 600–1300 − low` drives the /a/ vs /o/ opening and the a/i/u/e/o viseme split.
2. **Adaptive gain (小声)** — instant-attack / 2.5 dB/s-decay peak tracker; open range = 26 dB below the peak (never below −50 dBFS, so hiss stays shut). 小声 max open 0.25 → 0.97, coverage 75.7 % → 93.8 %.
3. **Idle decay** — the speaker tap stops posting frames when playback ends, so the mouth used to freeze at the last value (0.06) until `assistant_speech_ended`; `sample()` now decays to closed after 2 windows without audio (close/stop latency became measurable: 237 / 179 ms).
4. Smoothing of `mouthForm` (τ 60 ms) and a milder opening shape (wide vowels +20 %).

Known weakness: spurious opening rose on 小声 (4.2 % → 14.4 %) — the metric's absolute −58 dBFS "silence" gate counts the quiet take's low-level tails (still audible relative to its peak) as silence; the adaptive gain opens the mouth there by design. A relative silence gate (peak −35 dB) would be the fairer metric; left as is so the before/after columns stay comparable.

### Per-tag, final run
| tag | n | coverage % | spurious % | open ms | close ms | stop ms | mean form | max open |
|---|---|---|---|---|---|---|---|---|
| 母音_a | 3 | 97.6 | 0.0 | 20 | 192 | 198 | 0.52 | 0.99 |
| 早口 | 64 | 97.1 | 1.6 | 16 | 195 | 197 | 0.21 | 0.97 |
| 小声 | 64 | 93.8 | 14.4 | -34 | 321 | 154 | 0.05 | 0.97 |
| 母音_i | 3 | 97.5 | 0.0 | 12 | 186 | 206 | 0.63 | 0.99 |
| 母音_u | 3 | 96.9 | 0.0 | 17 | 183 | 211 | 0.11 | 0.92 |
| 母音_e | 3 | 95.0 | 0.0 | 39 | 184 | 219 | 0.44 | 0.99 |
| 母音_o | 3 | 98.4 | 0.0 | 14 | 193 | 187 | -0.42 | 0.87 |
| 促音 | 5 | 93.1 | 0.0 | 17 | 190 | 200 | 0.39 | 0.99 |
| 拗音 | 5 | 98.3 | 0.0 | 15 | 198 | 179 | -0.02 | 0.97 |
| 長音 | 5 | 98.4 | 13.3 | 8 | 204 | 183 | 0.14 | 0.97 |
| 数字 | 6 | 99.2 | 0.0 | 13 | 208 | 161 | 0.20 | 0.99 |
| 会社名 | 5 | 97.5 | 0.0 | 17 | 195 | 164 | 0.17 | 1.00 |
| 英単語 | 5 | 96.9 | 0.0 | 10 | 188 | 157 | 0.27 | 0.99 |
| 英日混在 | 5 | 97.9 | 0.0 | 2 | 188 | 154 | 0.22 | 0.99 |
| 疑問文 | 5 | 98.1 | 0.0 | 13 | 184 | 224 | 0.18 | 1.00 |
| 感情発話 | 6 | 97.0 | 0.0 | 27 | 200 | 213 | 0.21 | 0.98 |
| 長文 | 2 | 98.8 | 0.0 | 6 | 220 | 155 | 0.25 | 1.00 |

### Per-tag before → after
| tag | coverage % before → after | spurious % before → after | mean form before → after |
|---|---|---|---|
| 母音_a | 97.7 → 97.6 | 0.0 → 0.0 | -0.7 → 0.5 |
| 早口 | 95.3 → 97.1 | 0.2 → 1.6 | -0.8 → 0.2 |
| 小声 | 75.7 → 93.8 | 4.2 → 14.4 | -0.9 → 0.0 |
| 母音_i | 96.8 → 97.5 | 0.0 → 0.0 | -0.7 → 0.6 |
| 母音_u | 96.9 → 96.9 | 0.0 → 0.0 | -0.8 → 0.1 |
| 母音_e | 97.7 → 95.0 | 0.0 → 0.0 | -0.8 → 0.4 |
| 母音_o | 98.7 → 98.4 | 0.0 → 0.0 | -0.9 → -0.4 |
| 促音 | 91.5 → 93.1 | 0.0 → 0.0 | -0.7 → 0.4 |
| 拗音 | 97.1 → 98.3 | 0.0 → 0.0 | -0.8 → -0.0 |
| 長音 | 97.6 → 98.4 | 0.0 → 13.3 | -0.8 → 0.1 |
| 数字 | 97.7 → 99.2 | 0.0 → 0.0 | -0.8 → 0.2 |
| 会社名 | 96.0 → 97.5 | 0.0 → 0.0 | -0.8 → 0.2 |
| 英単語 | 97.9 → 96.9 | 0.0 → 0.0 | -0.8 → 0.3 |
| 英日混在 | 96.8 → 97.9 | 0.0 → 0.0 | -0.8 → 0.2 |
| 疑問文 | 97.6 → 98.1 | 0.0 → 0.0 | -0.8 → 0.2 |
| 感情発話 | 95.8 → 97.0 | 0.0 → 0.0 | -0.7 → 0.2 |
| 長文 | 98.0 → 98.8 | 0.0 → 0.0 | -0.8 → 0.3 |

## MotionSync status
`docs/reports/lipsync/motionsync-2026-08-30T00-59-05.md`:
```
BLOCKED_BY_MOTIONSYNC_CORE: BLOCKED_BY_MOTIONSYNC_CORE: core script not available at /vendor/live2d/live2dcubismmotionsynccore.min.js (failed to load /vendor/live2d/live2dcubismmotionsynccore.min.js). Download the Cubism MotionSync Plugin for Web from https://www.live2d.com/en/sdk/download/motionsync/ and place live2dcubismmotionsynccore.min.js at vendor/live2d/.
```
Unblock: put `live2dcubismmotionsynccore.min.js` (from the Cubism MotionSync Plugin for Web package) at `vendor/live2d/`, then
`pnpm --filter @rcai/avatar-live2d demo` and `node demo/ab-run.mjs --engine motionsync --character kei` (Kei_basic maps Silence/A/I/U/E/O → ParamMouthForm/ParamMouthOpenY, CRI engine, 60 fps, smoothing 60, blend 0.5). `lipSyncEngine: "auto"` in the web app switches to MotionSync automatically for models that reference a `.motionsync3.json` once the Core is present.

## Licenses
- `src/motionsync/*` is a port of *Cubism Web MotionSync Components* Framework (© Live2D Inc., **Live2D Open Software License**; business users above ¥10M revenue need the Cubism SDK Release License). Not a verbatim copy: csmVector/CubismJson/CubismModel dependencies replaced; attribution kept in each file header.
- MotionSync **Core** = Live2D Proprietary Software License + CRIWARE; never redistributed here.
- `characters/kei` = Live2D sample model *Kei_basic* (Live2D Free Material License / sample model terms), fetched locally, git-ignored.
- Corpus WAVs are generated locally with macOS `say` (Kyoko); git-ignored.

## Out of scope / notes for the parent
- `docs/source-manifest.md` / `docs/acceptance-gates.md` not edited (outside scope): Gate 3 can cite this report; add `characters/kei` to any character lists.
- `SpeakerOutput.tap` (audio-core) stops emitting frames after playback ends; the analyzer now handles it, but a continuous silence tap would make "audio stopped" observable to every consumer.
- Demo server left stopped.
