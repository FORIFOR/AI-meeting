# P1 report — Human Reality Gate tooling · Listener Semantics · Evidence-based evaluation (2026-08-30)

## (a) Human Reality Gate
- `docs/human-gate.md` — 10-minute protocol (3–5 testers, Free Talk 5 min + Interview 5 min), KPI order with **Listening 中の自然さ** first, 12 observation tags, PASS criterion.
- `apps/web/src/components/humanGateStore.ts` — localStorage store (`rcai.humangate.v1`), `submitGate()` (POST `/api/feedback`; **strict_local ⇒ local-only, no network**).
- `apps/web/src/components/HumanGatePanel.tsx` — overlay toggled from the session menu「評価パネル · Human gate」; one tap logs `{at, tag, avatarState, last 2 captions, mode, characterId, providerId}` (12 tags incl. 👍良い瞬間).
- `apps/web/src/screens/Result.tsx` — observations timeline (+seconds, avatar state, captions), 5-point rating (Listening 自然さ / presence / 遅延 / 日本語), 「記録を保存」→ broker, 「JSON をコピー」(clipboard; downloads are blocked in some sandboxes), クリア.
- `services/token-broker/src/routes/feedback.ts` + `/api/feedback` in `app.ts` (`feedbackDir` dep for tests) → appends JSON lines to `docs/reports/human/<date>.jsonl` (git-ignored; `README.md` kept). Test: 2 valid + 1 invalid entries → 2 written, 400 on empty.
- CSS: `.gate*`, `.criteria/.criterion*`, `.qtable`, `.star`, `.speech` in `global.css`.

## (b) Listener Semantics (`packages/behavior-engine`)
- `src/listenerSemantics.ts` — `classifyListener(text)` → `positive | serious | surprising | uncertain | emotional_negative | neutral` + intensity, JP/EN lexicon (failure/loss, problems/risk, 実は/突然, hedges/fillers, achievements, numbers with units, laughter/exclamation). Negative dominates mixed sentences (「改善を頑張ったんですが、結局うまくいかなくて」→ emotional_negative). `ListenerSemantics` debounces partial-transcript flicker, remembers the category, debounces gestures 1.5 s.
- Reading → listening expression on the **same tick** in `BehaviorEngine.handleEvent(user_transcript)` (partial + final): emotional_negative → `concerned` + gaze slightly down + smile suppression; serious → `serious`, slower nods; surprising → `surprised` + eyebrow_raise; uncertain → `thinking` + head_tilt; positive → `warm_positive` + nod. `ListeningScheduler` now takes `category`/`nodRate`: grave content ⇒ slower, smaller nods only, never `nod_normal`/happy gestures. `planUserText` (async refinement) can only soften, never turn serious/negative into a smile; remote planner used only if configured.
- Tests (`behavior.test.ts`, 9 total): 「実はそのプロジェクトは失敗してしまって……」 ⇒ concerned/serious set synchronously, **no smile/laugh/happy** across 12 s of listening; 「前職では5人のチームをまとめていました」 ⇒ warm_positive + nod; 「えっと、たぶん…」 ⇒ head_tilt + thinking; debounce/category memory.

## (c) Evidence-based evaluation (`services/evaluation`)
- `src/evidence.ts` — `EvidenceEvaluation extends EvaluationResult` (additive; §21 fields intact) with `criteria[] {key, score, evidence[{turnIndex, quote}], explanation, improvement, proxy?}`, `speech {paceCharsPerSec, pauseMeanMs, fillerRate, fillerCount, interruptions, answerDurationMeanMs, wordsPerTurn}`, `questions[]` (per interviewer question: relevance, specificity, STAR flags, issues), `warnings[]`; `validateEvidence()` keeps only verbatim substrings (re-anchors wrong turn indexes, drops paraphrases). `@rcai/provider-core` was **not** modified — extra fields ride along structurally; UI narrows with `isEvidenceEvaluation()`.
- `src/evidenceHeuristic.ts` — interview criteria relevance / specificity / star_structure / logical_clarity / conciseness / confidence with quotes (e.g. specificity flags 「なんとかチームで解決しました」→「具体的な数値・自身の行動を追加」), STAR marker detection (S/T/A/R lexicons JP+EN), per-question breakdown; English criteria fluency / grammar (recurring patterns: irregular past, a/an, 3rd-person -s, uncountables, double comparatives) / vocabulary (TTR, intensifier stacks) / naturalness (JP slips, contractions) / **pronunciation_proxy** (explicitly labelled: pace/fluency only, no acoustic analysis — a Pronunciation Engine is still required).
- `heuristic.ts` returns the evidence layer and appends evidence-backed feedback lines; `prompt.ts` numbers transcript lines `[n]`, adds the verbatim-quote rule + `criteria` to `EVALUATION_JSON_SCHEMA` / Gemini schema; `parseEvaluationResult(text, evaluatedBy, input)` validates LLM evidence and computes `speech`/`questions` locally; `llm.ts` passes `input`.
- Tests (`evaluation.test.ts`, 15 total): all heuristic quotes are verbatim user-turn substrings; good > rambling on every evidence criterion; STAR all-true on a structured answer; English profile keys + proxy label; parser drops a paraphrased quote and an unknown key, re-anchors a wrong index, reports 2 warnings.
- Result screen renders criteria cards (score, explanation, quotes, improvement, PROXY badge), speech chips, and the per-question table with S/T/A/R indicators.

## Commands / results
- `pnpm --filter @rcai/behavior-engine --filter @rcai/evaluation --filter @rcai/web --filter @rcai/token-broker typecheck` → all Done
- `pnpm vitest run packages/behavior-engine services/evaluation apps/web services/token-broker` → 41 passed, **1 failed outside my scope**: `token broker > /health reports configured providers as booleans only` expects 5 provider keys but `/health` now returns 6 (Fork H's concurrent meeting/recall change to `app.ts`); the feedback test passes.
- `pnpm --filter @rcai/web build` → ✓ built

## What remains for a real human session
- Run `docs/human-gate.md` with 3–5 testers on a real mic/speaker (no automated substitute for this); collect `docs/reports/human/<date>.jsonl` and summarize in `docs/acceptance-gates.md`.
- Pronunciation is a proxy until an acoustic engine exists; LLM evidence path is device-untested (BLOCKED_BY_OPENAI_KEY / GEMINI_KEY); local LLM path via agent `/evaluate` uses the new prompt but was not re-run here.
- Not touched: `@rcai/provider-core` types, `App.tsx`, `Home.tsx`, `SessionController.ts`.
