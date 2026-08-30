# Gate 7 / Reality Gates A–D — web app end-to-end in real Chrome (2026-08-30)

Runner: `apps/web/scripts/e2e-browser.mjs` — real Google Chrome 152 (headless, SwiftShader WebGL) driven by puppeteer-core with a **fake microphone WAV** (`--use-file-for-fake-audio-capture`), against the running local stack:
`scripts/local-stack.sh start` (llama-server + gemma-4-E2B Q4_K_M) · `pnpm --filter @rcai/agent start` (Silero VAD + SenseVoice STT + macOS `say`) · `pnpm --filter @rcai/token-broker start` (no keys) · `pnpm --filter @rcai/web dev`.
Settings seeded: engine=local, privacyMode=**strict_local**, character=yui (Live2D Hiyori), HUD on. Product: 面接練習 / persona 面接官（日本語）/ 日系大手企業 / Standard.

Mic WAV (all generated with `say -v Kyoko`): 3.0 s silence → 「こんにちは、今日は面接の練習をお願いします。」→ 2.2 s → 「ちょっと待って、質問があります。」(barge-in) → 12 s → 「はい、私の強みは粘り強さです。前職では半年かけて業務改善を進め、処理時間を三割短縮しました。」

## Observed (docs/reports/img/gate7-results.json, gate7-*.png)
State pill timeline (ms since session screen):
```
    3 Connecting → 977 Idle → 1078 Thinking (opening line) → 4165 Listening (user utterance 1)
 8484 Thinking → 10220 Speaking → 10703 Listening   ← barge-in: Speaking→Listening
13041 Thinking → 14486 Speaking → 22918 Idle → 24652 Listening (utterance 3)
34599 Thinking → 36539 Speaking
```
Captions (STT = SenseVoice, LLM = Gemma 4 E2B, TTS = say/Kyoko):
- You: こんにちは、今日は 面接 の練習 を お願い し ます。
- AI: 本日は面接にお越しいただきありがとうございます。 (interrupted)
- You: ちょっと待って質問があります。
- AI: 本日は面接にお越しいただきありがとうございます。それでは、まず簡単に自己紹介をお願いできますか。
- You: はい、私の強みは粘り強さです 前職では半年かけて業務改善を進め、処理時間を3割短縮しました。
- AI: なるほど、半年かけて業務改善を進め、処理時間を三割短縮されたのですね。具体的にどのような課題に対して、どのように粘り強く取り組まれたのか、もう少し詳しく教えていただけますか。

Latency HUD (LatencyTracker, local provider):
| metric | measured | target |
|---|---|---|
| turn response p50 / p95 | **2166 / 2382 ms** (n=3) | < 700 / 1500 — **NOT MET** with macOS `say` TTS (~650–770 ms fixed) + Gemma on CPU/Metal; STT+LLM alone ≈ 0.4 s (see gate6 report) |
| barge-in → audio stop | **43 ms** (n=1) | < 150 ✓ |
| speech detected → LISTENING | **0 ms** (n=3) | < 100 ✓ (runtime local VAD fast path) |
| audio stopped → mouth closed | **0 ms** | < 100 ✓ |

Result screen: evaluation rendered after End (overall **75**, `evaluatedBy` local LLM via agent `/evaluate`); no scores were shown during the session (§19).
Errors: none except `favicon.ico 404` (fixed afterwards with an inline icon). No non-loopback requests (strict_local; agent egress log empty in gate6).

## Fixes made during this run
- `characters/index.js`, `characters/src/index.js`, `personas/src/*.js` stray CJS artifacts broke `@rcai/characters` in the browser (`exports is not defined`) → removed, `.gitignore`d.
- Opening instruction text was echoed as a "You" caption and recorded as a user turn → `ConversationRuntime.sendText(text, { hidden: true })` (not recorded, provider echo swallowed); SessionController uses it.
- HeyGen broker route rewritten to the current LiveAvatar API (`sessions/token` → `sessions/start`, `+ /api/avatar/heygen/stop`) to match Fork G's adapter.

## Reality Gate mapping
- Gate A (conversation): 40 s continuous session survived, 3 turns, barge-in worked, Japanese replies 1–2 sentences, one question at a time. 10-minute soak and OpenAI/Gemini switching: **not run** (BLOCKED_BY_OPENAI_KEY / BLOCKED_BY_GEMINI_KEY); Local↔Local switch path exists in UI (untested with two engines).
- Gate B (character): Live2D moved through all states; blink/gaze/nod driven by BehaviorEngine (screenshots gate7-session-*.png); 10-minute eyes-on observation **not performed** (headless).
- Gate C (lip sync): analyzer path verified on synthetic vowels (gate2 report) and on real `say` speech here (mouth opened during Speaking); 50-sentence corpus **not run**.
- Gate D (provider switch without UI change): architecture verified by tests (runtime.switchProvider) — cloud engines BLOCKED by keys.

## Second run (after Codex fixes; vendored Cubism Core, provider-owned opening)
```
1 Connecting → 969 Idle → 1993 Speaking (opening spoken by the agent, no synthetic "You" caption)
4240 Listening → 8448 Thinking → 10256 Listening (barge-in) → 13011 Thinking → 14233 Speaking
24845 Listening → 34640 Thinking → 36071 Speaking → 46392 Idle
```
HUD: turn p50/p95 **1670 / 1947 ms** (n=2) · barge-in stop **43 ms** (n=2) · → listening **0 ms** (n=3) · mouth stop **0 ms** (n=2). Result overall 75. Toasts: none. Errors: none. Agent egress log: `[]`.
