# Gate 8 (Personas) / Gate 9 (Evaluation sidecar) — Fork E report (2026-08-30)

## Files created / changed
### services/evaluation (`@rcai/evaluation`)
- `src/record.ts` — `sessionRecordToEvaluationInput(record, params?, profile?)`, `defaultProfileForMode`, `resolveProfile`, `EvaluationProfile` (`interview_standard | english_conversation | sales_roleplay | free_talk`). Never copies audio bodies (only `userLevelDb`).
- `src/heuristic.ts` — `HeuristicEvaluator` (EvaluationProvider id `local`, zero network) + `evaluateHeuristically`, `englishDeferredNotes`, `buildImprovedAnswer`, `tokens`, `isJapanese`. JP/EN filler, hedging, sentence length, structure markers (結論/理由/例えば/first/because…), concreteness (numbers/katakana/proper nouns), relevance = token overlap question↔answer (JP char-bigrams / EN words), fluency from silences/speaking rate/interruptions; profile-weighted overall; JP or EN feedback strings; improvedAnswer = longest answer restructured as 結論→理由→具体例 (EN: In short/The reason/For example); english profile adds batched grammar notes + Japanese-mixing note (no per-sentence correction).
- `src/prompt.ts` — `buildEvaluationPrompt(input) → { system, user }` (JP/EN rubric per profile + exact JSON schema + transcript/timing/interruptions), `EVALUATION_JSON_SCHEMA` (JSON Schema), `EVALUATION_GEMINI_SCHEMA` (OpenAPI subset, UPPERCASE types), `parseEvaluationResult(text, evaluatedBy?)` (code fences/prose tolerant, clamps 0–100, fills missing, overall = mean when absent), `EvaluationParseError`.
- `src/llm.ts` — `evaluateWithOpenAICompatible({ baseUrl, apiKey?, model, fetch?, timeoutMs?, temperature? }, input)` (chat/completions with `response_format: json_object`; on HTTP 400 retries without it; works for OpenAI and llama.cpp/Ollama/vLLM/MLX servers), `evaluateWithGemini({ apiKey, model, fetch?, timeoutMs?, baseUrl? }, input)` (`generateContent` with `systemInstruction`, `generationConfig.responseMimeType`/`responseSchema`, header `x-goog-api-key`; field names verified against https://ai.google.dev/api/generate-content), typed `EvaluationError { kind: config|http|timeout|parse|network, status? }`. Missing Gemini key ⇒ `EvaluationError("config","BLOCKED_BY_GEMINI_KEY")`. Nothing is ever faked.
- `src/sidecar.ts` — `EvaluationSidecar({ getRecord, provider?, params?, evaluationProfile?, onError? })`: `attach(runtime)`, `handleEvent(ConversationEvent)` (counts final user transcripts), `onInterval(turns=4, cb, provider?)` (spec §20 deferred feedback), `evaluateNow(provider?)`, `evaluateFinal()` (resolves null + onError on failure), `dispose()`. Fire-and-forget; never in the conversation path.
- `src/index.ts`, `src/evaluation.test.ts` (10 tests).

### personas (`@rcai/personas`)
- 13 persona JSON files: `interview/interviewer_ja.json`, `interview/interviewer_en.json`, `english/{english_free_talk,english_travel,english_business,english_interview,english_daily,english_pronunciation,english_beginner}.json`, `sales/sales_customer_ja.json`, `tutor/tutor_ja.json`, `free_talk/friend_ja.json`, `career/career_coach_ja.json`. All conform to `Persona`; interview personas forbid in-conversation scoring, ask one question at a time, have `params` (position/companyStyle/difficulty/interviewStyle) with `{{param}}` templates and an `opening`; English personas use `correctionPolicy: "deferred"`; maxSentences ≤ 3 everywhere (spec §22).
- `src/catalog.ts` — validates every JSON at load; exports `personas`, `personasByMode`, `createPersonaRegistry(extra?)`, `getPersona(id)`, `DEFAULT_PERSONA_ID`.
- `src/index.ts` — `export * from "./catalog.js"`; root `personas/index.ts` re-exports `./src/index.js` (contract path).
- `src/personas.test.ts` (4 tests). `tsconfig.json`: fixed `extends` depth (`../tsconfig.base.json` — personas is one level deep; the scaffold used `../../`). NOTE (outside my scope): `characters/tsconfig.json` has the same wrong depth.

## Commands run & results
- `pnpm vitest run services/evaluation personas` → **2 files, 14 tests passed**.
- `pnpm --filter @rcai/evaluation --filter @rcai/personas typecheck` → **Done / Done**.
- `pnpm vitest run` (whole repo, sanity) → 21 files passed / 1 failed (2 tests) in another fork's in-progress package:  ❯ services/agent/src/agent.test.ts (14 tests | 1 failed) 2494ms  FAIL  services/agent/src/agent.test.ts > SentenceChunker > strips markdown and emoji  ❯ services/agent/src/agent.test.ts:46:57  — not in my scope, untouched.

## Notes / quirks
- vitest externalizes `personas/src/index.ts` when imported relatively as `./index.js` (Node then loads `@rcai/persona-core` natively and fails on `./persona.js`). Importing the same content under another file name (`catalog.ts`) or via the package name works, so the real module lives in `catalog.ts` and tests import it directly. Consumers should import `@rcai/personas` (works via pnpm workspace symlink).
- Heuristic scores on the fixture: structured JP interview answer → overall ≥ 70, rambling → < 60, ordered on every dimension.

## Blocked
- LLM-backed evaluation device tests: **BLOCKED_BY_OPENAI_KEY**, **BLOCKED_BY_GEMINI_KEY** (mocked-fetch unit tests only). Local-LLM evaluation (`evaluateWithOpenAICompatible` against llama-server) is exercised by Fork D's `services/agent` `/evaluate` endpoint.
