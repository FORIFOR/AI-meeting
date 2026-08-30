# UI design — 稽古場の進行表 (a rehearsal running-order sheet)

The interface is a printed program for a rehearsal: paper for everything you do **before and after** talking, and one dark surface — the stage — for the conversation itself. That light→dark switch is the only dramatic moment in the app; nothing else needs decoration.

## Rules
1. **Japanese first.** No 日本語/English double labels. Latin appears only for proper nouns (OpenAI, Gemini, Google Meet), technical readouts (the latency HUD, `strict_local`), and the small state word in the status pill (which the E2E harnesses match on).
2. **Hairlines and numbers instead of cards.** The product list is a numbered running order with 1px rules; hover fills the row with ink. No drop shadows, no glows, no gradient fills except the stage lamp.
3. **One accent.** 朱 `--seal #b0402b`: the seal square favicon, the row numbers, the active plate, the underline in the headline, errors. Everything else is ink on paper.
4. **Type.** Display = Zen Old Mincho (headlines, character names, scores). Body = Zen Kaku Gothic New. Mono = IBM Plex Mono, restricted to numerals, codes and instrument readouts — never used as a decorative label font.
5. **Corners are 2px.** Buttons and inputs are rectangles; the only circle in the app is the realistic-avatar plate.
6. **Character plates, not avatars.** A character is shown as its own glyph (結・春・玲・慧) in a bordered plate — a name plate, not a fake portrait.
7. **Texture, not effects.** A single multiply-blended paper fibre layer on the shell; the stage gets a warm lamp pool and a soft vignette instead.
8. **Motion is one staggered reveal per screen** plus the row ink-sweep. Everything respects `prefers-reduced-motion`.
9. **Codes are for developers.** `BLOCKED_BY_*` is shown to the user as plain Japanese (「完全ローカル中は使えません」) with the raw code kept in the `title` attribute and in the reports.

## Tokens
`--paper #f4f1ea` / `--ink #191512` / `--seal #b0402b` / stage `--stage-0 #100e0c` with `--lamp #e8b877`. Full set at the top of `apps/web/src/styles/global.css`.

## Screens
`docs/reports/img/ui/` — home (running order), home hover (ink sweep), setup slip, stage (listening / speaking), result report, meeting, settings.
