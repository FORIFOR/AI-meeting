# Commercial gates — Google Meet resident AI

Two Recall bots talking to each other proves the transport. It does not prove a product a customer's
meeting can rely on. Nothing here is "done" because the code exists.

The gates are split, because they gate different promises:

- **Commercial Core** — "invite the bot to your Meet; the host admits it." Shippable with a documented
  limitation for Workspaces that refuse anonymous participants.
- **Authenticated Enterprise** — "it joins any company's Meet automatically." Only this one makes an
  authenticated bot a release blocker.

## Commercial Core

| # | Item | State | Evidence / what is missing |
|---|---|---|---|
| 1 | Conversational audio on Output Media | **PASS** | The character has always spoken through Output Media. Output Audio is now refused unless `RECALL_ALLOW_OUTPUT_AUDIO=1`, so the announcement endpoint cannot become the conversational path by accident. |
| 2 | Bot reserved ≥10 min ahead via Calendar V2 | **PASS** | Reserved when the event first syncs, armed ~12 min before; `decideEvent` refuses anything starting within 10 minutes (`starts_too_soon`). |
| 3 | Webhook-authoritative bot state | **PASS (code)** | See COMMERCIAL-GATE-04 below. |
| 4 | Fatal sub-codes as operator-readable errors | **PASS** | `describeBotFailure` covers `google_meet_bot_blocked`, `knocking_disabled`, `organisation_restricted`, `login_not_available` and the rest, never blanks out on a code Recall adds later, and the meetings screen shows the reason **and the fix** rather than 「参加できませんでした」. |
| 5 | Participants told an AI is listening | **PASS (code), UNVERIFIED LIVE** | `chat.on_bot_join` notice; shape from Recall's reference, never exercised — the workspace ran out of credit first. Confirmed by a human in the smoke gate. |
| 6 | 402 / 507 are operational states, not outages | **PASS** | `BLOCKED_BY_RECALL_CREDIT` and `BLOCKED_BY_RECALL_CAPACITY`. |
| 7 | Usage visible, empty account visible | **PASS** | `GET /api/recall/usage` reports billed bot hours (`bot_total` is seconds — 14053.27 matched 3.90 billed hours). Remaining credit is not exposed by the API, so `/health` carries `meeting.creditRefusedAt`: the first refusal is visible to operations instead of waiting for a user whose meeting did not happen. Auto top-up remains a dashboard setting. |
| 8 | **10-minute smoke with real people** | **AUTOMATED PASS 7/7 (2026-09-03) — real-people run still owed** | The five attempts of 2026-09-02 are kept below (「Gate #8 — attempts with a person」). Since then the gate has been run unattended: `pnpm reality:attendee:auto` sends the character and a second Attendee bot (「Tester」, listening, 1080p recording) into the same Meet room, the Tester speaks a scripted Japanese scenario through `say`, and the page's own events are scored per cue. **Run 15** (`bot_od48D1guEA1G8K66` / `bot_Qcy82rOEQ7LTlSwM`, local engine, `addressed_only`, Gemini 3.5 flash-lite as the LLM): greet PASS (greeting at T0−17.6 s, 170 audio frames, before the Tester was in the room), chat PASS (two people talking, turn=0), ask1 PASS (「ゆイ、今日の予定を教えて。」 → vocative, 5.1 s heard by the Tester), third PASS (third-person mention, no turn), bargein PASS (cut after 1 frame, silent for the 1.5–5 s after the cut-in), ask2 PASS (「ゆイ、今どう思う？」 → 2.6 s heard), silence PASS (turn=0). 28,840 chunks heard, 13 transcripts, five sanctioned LLM calls and no unsanctioned draft. Runs 10–14 and what each one fixed are in the section below. What this does **not** prove: a person's microphone through Meet's noise suppression, and ten minutes of unscripted talk — that is the run this row is named after, and it is still owed. |
| 9 | **30-minute reality gate with real people** | **BLOCKER** | `MINUTES=30 pnpm reality:meet:human`, after #8 passes. |
| 10 | Two-bot run is a transport test only | **PASS** | `reality:meet:live` is labelled as such and does not stand in for #8 or #9. |

## Gate #8 — attempts with a person (2026-09-02)

Two attempts on Attendee. Both reached the meeting: admitted, avatar rendered, webhook lifecycle complete, audio and
transcripts flowing. **Attempt 1** (`bot_hnPC8GruiRzkHXQ2`) aborted at ~3 min — the page routed to OpenAI, no credit,
seen and silent (429 in-call). **Attempt 2** (`bot_q21wV6BfaY1hHiq4`, Gemini) ran the full 10 minutes: page started,
56,266 audio chunks, 45 utterances, lifecycle PASS — and `addressed by name` **0**, so `character produced speech`
**0.0 s**. The person did call the name six times; the recogniser wrote 「ゆイ」 and the matcher is literal. Both causes
fixed and measured against that meeting's own transcripts (0 → 2 addressed). **Attempt 5** (`bot_GKv9mtW9nPLoM0S1`,
local engine, `addressed_only`, 10 min): admitted, lifecycle PASS, 28,619 chunks relayed — and the voice-agent page
never started on Attendee's side, so the room heard nothing; Attendee's own transcript has 2 utterances, one speaker.
Two things that run found with its recording as input, both fixed: the arrival greeting was dropped whenever the room
was not silent at +1.5 s, and the recording carries almost no speech — 57 bursts, 71 s in 534 s, mostly ≤1 s — so the
phone microphone through Meet's noise suppression is what the recogniser heard.

## Gate #8 — unattended runs in the real room (2026-09-03)

`pnpm reality:attendee:auto` (`scripts/reality/attendee-auto.mjs`). The character joins as 「Yui」 (bot page through the
three cloudflared tunnels: web, broker, agent); a second Attendee bot 「Tester」 joins the same room, records at 1080p and
plays a scripted scenario through macOS `say`. The host admits both. Scoring uses the bot page's own events, relayed to
the broker (`GET /api/meeting/session/:id` → `pageEvents`, `pageHeartbeat`) — `turn` (reason + text), `greeting`,
`spoke` (audio frames actually sent), `interrupted` — plus how many seconds of the character the Tester's recording
contains in each window.

| cue (T0+s) | Tester says | expected | Run 15 |
|---|---|---|---|
| greet (join) | — | greets on arrival | PASS — greeting @−17.6 s, 170 frames |
| chat (25) | two people talking, no name | stays quiet | PASS — turn=0 |
| ask1 (65) | 「ゆい、今日の予定を教えて」 | answers | PASS — vocative, 5.1 s heard |
| third (105) | 「ゆいが昨日そう言ってたよね」 | stays quiet | PASS — turn=0 |
| bargein (145) | 「ゆい、これはどう思う？」, then a second voice cuts in 「ちょっと待って、その前に…」 | stops | PASS — interrupted after 1 frame, 0.0 s audible after the cut |
| ask2 (190) | 「ゆい、今どう思う？」 | answers | PASS — vocative, 2.6 s heard |
| silence (230) | — | stays quiet | PASS — turn=0 |

Environment: local engine (SenseVoice incremental STT, silero VAD, Supertonic int8 TTS), LLM `gemini-3.5-flash-lite`
through the OpenAI-compatible endpoint with `LOCAL_LLM_REASONING=minimal` (`gemini-3.1-flash-lite` ran out of daily
quota; `gemini-2.5-flash-lite` is 404 for new users; 3.5 rejects `reasoning_effort: "none"` with 400).
Latencies on the three answered turns: first token 0.63–0.85 s, total 1.3–2.2 s.

What the runs found, in order (each fixed in the commit named, then re-run):

| run | result | what was wrong | fix |
|---|---|---|---|
| 10 | greet FAIL | the page greeted into an agent socket that was not open yet; a turn nobody answered kept the floor | `027e5db` — `runtimeReady` gate, 20 s answer watchdog, `released` event |
| 11–12 | void | LLM 404 (`gemini-2.5-flash-lite`), then 400 (`reasoning_effort: "none"` on 3.5) | model + `LOCAL_LLM_REASONING=minimal`; the leftover bots were told to leave |
| 13 | greet FAIL, ask2 FAIL | a 200 ms noise onset dropped the thinking-phase turn; the recogniser wrote 「つい今どう思う？」 and the vocative did not match | `d5aacd2` — 600 ms barge-in confirmation while thinking on the bot page; `soundalikes` (い/うい/つい/ゆ at an utterance onset, question or request only) on the character |
| 14 | greet FAIL (scoring), noise follow-ups | greeting happened 25.9 s before T0 and was judged from T0; 「你。」「Great.」「Okay。」 counted as engaged follow-ups | `3b7fe0c` — greet judged from its own event; `isFollowUpWorthy` rejects backchannels and one-word noise |
| 15 | **7/7 PASS** | — | — |

Also from the runs: the agent is now `autoRespond: false` on a meeting page — it transcribes, and only the page's
sanctioned `text` turn generates (`ab73149`), so an unsanctioned draft can no longer be cut mid-sentence by the page.

What Run 15 sounded like, measured from the Tester's recording against the same reply rendered again on this
machine (`02a41b6`): the character was heard at 44.1 kHz through an ~8 kHz path (99.9 % of the energy under 6.3 kHz —
the Tester's own `say` lines come through the same way, so this is Meet, not the page), with no clipping, and with
1.1 s holes inside the answer. The holes were not the network: Supertonic pads every phrase with 270–570 ms of
silence before the first sound and ~550 ms after the last, and the agent speaks phrase by phrase, so each phrase
boundary was a second of nothing and each reply began with up to half a second of silence counted as first audio.
The adapter now trims that padding (60 ms kept in front, 150 ms behind; a 7.3 s reply became 5.9 s) and scales
peaks under −0.45 dBFS — at `SUPERTONIC_STEPS=2`, which the run used, the same sentence came out ~10 dB hotter than
at 8 and clipped 248 samples. The agent runs at `SUPERTONIC_STEPS=4` (0.13× realtime on this Mac) from Run 16 on.

The gate now also judges every answer as sound — span heard against seconds sent, longest gap, clipping share,
f99 bandwidth — reads the reply for a parroted name, and asks the agent one text turn before creating any bot.
Replayed over Run 15's recording the new check flags exactly the 1070 ms gap in ask1 (f99 5.1 kHz, 0 clipped
samples). The meeting prompt now says the transcript may misspell the name and not to repeat it; whether that holds
in the room is what the in-run check is for.

**Run 16: BLOCKED_BY_ATTENDEE_CREDIT** (2026-09-03) — `attendee_create_bot_failed: Organization has run out of
credits`. The preflight answered in 2.7 s; no bot was created. The row above stays owed a person: a real
microphone, unscripted, ten minutes.

**Runs 17–28: self-hosted Attendee, and what the host could give it** (2026-09-03). With the hosted
credit gone the gate moved to Attendee's own open-source stack on this Mac (`scripts/reality/attendee-selfhost/`,
Docker Desktop, the amd64 image under Rosetta — the four services, Postgres, Redis, MinIO for the recordings;
three local patches in the clone, kept as `scripts/reality/attendee-selfhost/local-patches.diff` and applied
with `attendee-selfhost.sh patch`: extra Chrome switches for diagnostics, no forced debug screen recording, and
back-to-back scheduling of the bot's queued output audio — the seccomp profile Docker's runc cannot load is reset
in `compose.rcai.yaml`). Two bots in one Meet room is one Chrome per bot in the worker plus the webpage-streamer's software
GL and VP8 encode, all emulated.

| run | outcome | what it said |
|---|---|---|
| 17, 18 | not run — `FAIL: both bots were not admitted in time` | nobody in the Meet to admit them; Meet drops a knock after ~10 min (`request_to_join_denied` at 600 s), so a run has to start while a person is already in the room |
| 19 | greet, chat, third, silence PASS; **ask1, bargein, ask2 FAIL** (`heard=0.0s`, nothing audible) | the Tester relayed 2,247 chunks and then nothing — the two bots starved each other; the first run with both in the room |
| 20 | 4/7; `answers as sound` **DEGRADED** | the question reached Yui in fragments (turn=none); VM load 13.8 on 10 CPUs; the debug screen recording (a second x264 encoder per bot) switched off from here |
| 21 | 5/7 — ask2 PASS (vocative sound-alike, 4.1 s heard, gap 3.8 s) | the Tester's page hit 33 fps; ask1 still fragmented |
| 22 | **5/7** — ask1 PASS (10 s heard, gap 4.5 s), bargein PASS, ask2 PASS but `×3.14 stretched (underruns)`; third FAIL (turn=1, answered a third-person mention) | VM load **21.6**, streamer 360–510 % CPU at 1280×720 → frame size cut to 640×360 |
| 23 | 4/7, DEGRADED — `f99=1063–1688 Hz muffled` | worker 260–460 % CPU, 5.6 GiB; load 23.8 |
| 24 | 4/7 + ask2 PARTIAL (reply drafted 「へえ、昨日そんな話してたんだっけ？…」, nothing audible); **tester heard the room: FAIL, 0 chunks** | the Tester's relay never carried audio; load 20.4 |
| 25 | 4/7, DEGRADED (ask1 gap 2.4 s, f99 1.9 kHz) | Yui's join took 138 s; load 18.3 |
| 26 | greet PASS then `output_audio failed 500 … connection to server at "postgres"` | Docker's disk filled: `write … meta.db: read-only file system`; Postgres gone mid-run. 2.2 GB free → 14 GB after the clean-up (old images, build caches, Chrome profiles); Docker needs ~12 GB for this stack |
| 27, 28 | not run — not admitted within 600 s | nobody in the Meet; the stack itself was healthy (load 0.03 before launch) |
| 29 | not run — `BLOCKED_BY_NO_ADMITTER` (`fatal_error` at 621 s, Meet's own 600 s knock limit; `ADMIT_TIMEOUT=900` cannot outlast it) | launched 19:41 JST with the relief settings, the hedged LLM and the "not just I don't know" rule in place, tunnels 200, load 2.2; nobody in the room. The same configuration is run 30 the moment a person is |
| 30 | not run — `BLOCKED_BY_NO_ADMITTER` (`request to join was denied` at 620 s) | first run on the native arm64 image, launched 20:29 JST, load 0.75 at launch; both bots knocked within 30 s and waited the full 600 s; nobody in the room. Run 31 is this configuration with a person there |
| 31–40 | not run — `BLOCKED_BY_NO_ADMITTER` ×10 | a knock kept alive from 20:42 to 22:37 JST (the run relaunched every time Meet dropped it, ~11 min a cycle, native image, load 0.5–1.0): ten consecutive 600 s knocks, two 「You can't join this video call」 retries handled by Attendee, nobody in the room. The stack is ready; the room is the blocker |
| 41 | not run — `BLOCKED_BY_NO_ADMITTER`; Tester `fatal_error` | the 13th consecutive knock: Meet served the Tester its no-`<audio>` variant five times in a row (`UiGoogleWrongAudioConfigurationException` ×5 → 「blocked by platform repeatedly, so recreating pod」, which the local Docker mode cannot do). Knocking every 11 min is now costing goodwill with Meet, so the loop was stopped here rather than poison the run that a person finally admits |
| 42 | not run — `BLOCKED_BY_NO_ADMITTER` | one gentle knock an hour later (23:05 JST): both bots reached the lobby cleanly, nobody in the room |
| 43 | not run — `BLOCKED_BY_NO_ADMITTER`; Tester `fatal_error` at 94 s | launched on 「続けてください」 with a person asked to admit; the Tester drew Meet's no-`<audio>` variant five more times, and the first in-place relaunch (local patch to `restart_bot_pod`) died on `has already initiated this bot request` because the relaunch skipped upstream's reset of `requested_bot_action_taken_at`. Fixed in the patch (same bookkeeping as the pod path) before run 44 |
| 44 | **first admitted run**: 6 / 7 cues PASS (`silence` FAIL), `answers as sound` DEGRADED, avatar `BLOCKED_BY_NO_WEBGL` | a person admitted both bots at 24 s (23:23 JST). Greeting, `chat`, `ask1`, `third`, `bargein`, `ask2` all PASS on the first try. Three findings, each with a fix before run 45: (1) the character's tile showed the page's no-WebGL notice, not the avatar — Chromium 151 on the arm64 image gives no WebGL under `--disable-gpu` without `--enable-unsafe-swiftshader` (probed in the streamer container: `webgl2 … SwiftShader`); (2) the room had an open mic carrying continuous speech (Tester recording: 「〜んですけど、でもですね」「知れば知ることしやすくなるから」), attributed to the engaged Tester, so from 69 s every answer — `ask1` included, 4 s in — was cut off by barge-in: 15 half-sentences, hence the muffled/short `ask1` audio and the `silence` turn; the policy now drops a follow-up engagement after three cut-offs in a row (`maxInterruptedInARow`); (3) SenseVoice ran with `language: auto` and decoded the noise as Chinese/Korean (「嗯什了你」「给个ら啊」); it is now built per session language (`ja`). Not a clean verdict — the next run needs the admitter's mic muted |
| 45 | 6 / 7 cues PASS (`third` FAIL), `answers as sound` DEGRADED, avatar **ok** | a person admitted both bots at 21 s (23:55 JST). The avatar rendered (SwiftShader fix confirmed) but the person's screenshot showed a Chromium Local Network Access prompt (Block / Allow) covering the face — the streamer payload's `fetch http://localhost:8000/offer_meeting_audio` trips Chromium 151's LNA check; the streamer now runs with `--disable-features=LocalNetworkAccessChecks` (not yet seen in a run). The admitter's mic was still open on one device: continuous speech attributed to the engaged Tester produced garbage follow-ups (`third` FAIL) and kept the room from ever being quiet, so the arrival greeting waited 70 s for a pause and landed inside `ask1`; a greeting that finds no pause within 30 s is now dropped (`greetingTtlMs`). Answers were grounded (ask2: 「昨日の資料にあった算定指目の数字については、あとで直してもらえるとのことだったので、一度確認しておいたほうがいいかなと思います。」) but slow to sound — Supertonic 2.5 s median per phrase, 6.5 s for 20-character ones (same as run 44's 453-phrase median, so not the SwiftShader load; pre-existing). Vendor transcript read 0/0 (unverified why). Next run: mic muted on every device of the admitter, face check |
| 46 | 5 / 7 cues PASS (`ask1`, `ask2` FAIL), avatar ok, face unobstructed | a person admitted both bots at 67 s (00:10 JST) with their mic muted; 「Yuiからの応答がありません」. Both misses are the character's, not the room's: (1) `ask1` — the utterance was committed as 「今日の予定を教えて。」, no name, so the policy never saw an address; the same mp3 decodes offline with the name at every lead-in tried (0/100/400/800 ms), so the audio that reached the recogniser was missing its onset. The agent can now dump each committed utterance's wav (`RCAI_DUMP_UTTERANCES`) to see what arrived, and the Tester's clips are led in with 400 ms of silence so the onset tested is a word, not a stream. (2) `ask2` — Gemini took 30.6 s to the first token on the barge-in follow-up (both hedged requests stalled), so 「分かりました、ではそちらの話を先にどうぞ」 was spoken at 187–190 s and 「ゆい、今どう思う？」 arrived 2.6 s after it ended — inside the 4 s cooldown, which dropped a direct address. Being called by name is now exempt from the cooldown and the consecutive cap (they guard the character's own initiative). Also fixed: the endpoint loop polled the VAD every ~1 ms while it re-detected speech (~170 evaluations in 300 ms). Not fixed: the 30 s cloud stall (no local fallback configured), vendor transcript 0/0 |
| 47 | **7 / 7 cues PASS** (first clean sheet), avatar ok; `answers as sound` DEGRADED (gaps), parrot check UNKNOWN (harness), vendor transcript 0/0 | a person admitted both bots at 610 s (00:44 JST). Greeting at T0+23 s, `ask1` and `ask2` both `turn=vocative` — the 400 ms lead-in delivered the name (committed as 「ゆイ、今日の予定を教えて。」, 「ゆイ、これはどう思う？」, 「ゆイ、今どう思う？」; utterance wavs dumped), the barge-in cut 「資料の数字の修正のことですね。」 at 230 frames, the follow-up 「ちょっと待って…」 was answered as an engaged follow-up (「承知しました。そちらの対応を優先しましょう。」), and the name-address 2.6 s later was taken (cooldown exemption from run 46). Replies: 「私の今日の予定は手元にありません。午後からは資料の修正作業を進める予定です。」 / 「資料の数字の修正についてですね。全体の数値の整合性を確認しておいたほうが安心だと思います。」 — no parroted name in any of them, read from the agent log because the harness only read `spoke` events inside the 15 s window and both landed 1.2 s and 0.1 s after it (`reply=""` → UNKNOWN; fixed for run 48). The gaps (`ask1` 4024 ms, `ask2` 3426 ms) are not TTS: they are 「えーっと、」 at 0.4 s followed by the first token at 3.8 s (three of six turns hedged; the greeting's two requests both stalled, 22.8 s). Fixes for run 48: the hedge ladder goes to three requests, the hedge fires at 1.8 s instead of 2.5 (soak data: 0.67–1.32 s or ≥ 2.4 s, nothing between), and a think still silent 2.2 s after the first filler gets a second one (「そうですね、」), never a third. Report `…/T/rcai-auto-1788449651850/report.json` |
| 48–50 | not run — `BLOCKED_BY_NO_ADMITTER` ×3 | three knocks after the run-47 fixes landed (01:04, 01:14, 01:25 JST, 04 Sep): 48 and 49 ran the full 614 s to Meet's `fatal_error`, 50 was cut at 249 s by hand so the token-broker could restart with the closed-caption transcription option (b8cb498) — the self-hosted Attendee has no Deepgram credential, which is why runs 44–47 read a 0/0 vendor transcript; the Tester now asks for Meet's own captions (`google_meet_language: ja-JP`, confirmed in the bot's stored settings on run 51). Nobody in the room for any of the three. The knock continues from run 51 with the 1.8 s three-step hedge, the second filler and the late-spoke attribution all in place |
| 51–62 | not run — `BLOCKED_BY_NO_ADMITTER` ×12 | a knock kept alive from 01:33 to 03:43 JST (04 Sep) on the closed-caption broker: twelve consecutive ~610 s knocks, every one ending in Meet's `fatal_error` (Tester ×10, Yui ×7 — the other bot was still `joining` when the run was called), nobody in the room. The first knock of this series carried the caption request end-to-end (Attendee stored `meeting_closed_captions: {google_meet_language: ja-JP, merge_consecutive_captions: true}` on the Tester; read against the vendor's source, `ja-JP` is in its `google_meet_language` enum and `google_meet_ui_methods.select_language` picks it in Meet's caption menu once the bot is in the call — so the setting is valid and acted on, and only the captions themselves remain to be seen). The loop stopped on its own at run 62; the next admitted run is the first evidence for the 1.8 s three-step hedge, the second filler, the late-spoke attribution and the caption transcript together. Resume: `MEET_URL=… ENGINE=local PROACTIVITY=addressed_only ADMIT_TIMEOUT=900 TESTER_RESOLUTION=720p YUI_RECORDING_FORMAT=mp3 YUI_PAGE_FPS=15 pnpm reality:attendee:auto` with a person in the room |
| 63 | **6 / 7 cues PASS** (`bargein` PARTIAL), avatar ok, `answers as sound` DEGRADED (gaps 3.3 / 3.6 s, muffled), parrot check UNKNOWN (0 replies read), vendor transcript **PASS** (3/13 utterances by Yui — the first Meet captions ever read by a run) | a person admitted both bots at 34–38 s (08:05 JST, 04 Sep) on the closed-caption broker with the whisper-async final pass and int8 Supertonic TTS. `greet` (T0+13.4 s), `chat`, `ask1` (`turn=name + question/request`), `third`, `ask2` (`turn=vocative`) and `silence` all PASS. Three findings from Yui's own recording (`yui.mp3`, energy-segmented and re-transcribed) and the agent log: (1) **the greeting died after 17 frames and the first answer was cut mid-sentence, and the agent had confirmed no barge-in for either** — the agent log reads `interrupt (client)`, i.e. the cut came from the bot page: the `ConversationRuntime`'s own energy VAD (`localVad`) ran on the room mix and its fast path (`user_speech_started` while speaking → `cancelGeneration` + `provider.interrupt`) stopped the character on the admitter's 「えっと」 (12.5–15.3 s) and on a low-level room blip at 76 s, bypassing the 600 ms confirmation window that lives in the agent. Fixed: the bot page no longer runs the runtime VAD (`localVad: role !== "bot"`, `MeetingSessionController`); the agent's confirmed onset is the only thing that stops her there, the operator page keeps its instant headset cut (2 tests). (2) `bargein` PARTIAL for the opposite reason: the cut-in that *should* stop her reached the agent 162.9–166.2 s, after the page had finished playing (160.2 s) — measured meeting latencies Tester clip → room ≈1 s, room → agent input 2–3 s, page playback → room ≈3–4 s, so a listener's interruption arrives ≥6 s after she starts and a short reply cannot be interrupted at all; the harness fires its cut-in on the page's `speaking` event, which precedes the first audio by the TTS time. The one legitimate cut (`ask2`, 195 s, the admitter's 「えーと」) *was* confirmed by the agent after 600 ms — the intended path works. (3) `answers as sound` DEGRADED is the host again: with the Attendee VM at ~520 % CPU, phrase TTS took 3–5 s (0.4 s in the offline runs), first audio 3.8 s, phrase gaps 3.3–3.6 s; the filler 「そうですね。」 covered the wait and Meet's captions carried the answer 「撮影時の数字の修正については、早めに進めておいた方が良さそうだと思います。」. No self-echo: the agent never committed Yui's own voice. `reply does not parrot` stays UNKNOWN because a cut reply emits no `spoke`. Next: run 64 with the page cut removed |
| 64–68 | `BLOCKED_BY_NO_ADMITTER` ×5 | the knock loop kept two bots at the door 08:30–09:30 JST (04 Sep) with the page cut removed; nobody in the room |
| 69 | **3 / 8 cues PASS** (`third`, `bargein`, `silence`), `greet` FAIL (sanctioned at T0+22.4 s, never spoke), `chat`/`ask1`/`followup`/`ask2` FAIL | admitted at 123 s (09:36 JST, 04 Sep), the first run on the eight-cue script (`followup` added: 「それって来週までに終わりそう？」 without the name, judged as an engaged follow-up). The character heard almost nothing: `heard=0.0–0.9 s` on every `say` cue, the Tester's clips reaching the agent as 0.5–1.6 s fragments, and the cues went unanswered for lack of a question, not a decision. Host load at launch was the worst of the day (`vm.loadavg` ≈5, the claude-mem backfill pegging a core beside the Attendee VM). Marker `DEGRADED_BY_HOST_CPU` |
| 70 | **6 / 8 cues PASS**, `ask1` FAIL (`turn=none heard=0.0 s`), `followup` FAIL (consequential: no engagement to follow up), `bargein` PASS (cut confirmed +6.1 s after the cut-in), vendor transcript PASS (7/17 by Yui, 「こんにちは。ゆうです。」「ゆいと声をかけていただければ返事しますね。」 (Meet's captions, verbatim)), `answers as sound` DEGRADED (gap 2.0 s, muffled) | admitted at 65 s (09:48 JST). `ask1` diagnosed end to end: Yui's own Attendee recording has 「ゆい、今日の予定を教えて」 intact at T0+75.8–79.2 s; the agent's utterance dump (`…_今日の予定を。.wav`) holds 1.0 s of speech surrounded by digital zeros (−93…−99 dBFS) — the question was zero-filled *before* it reached the broker: the broker relayed 29 879 messages for Yui and the page heard 23 270 mixed frames + per-participant, no drop in `RelayHub`, `AttendeeConnector`, `pushMicFrame` or `LocalProvider.pushAudio` (all read; none drops while connected, none reconnected). Attendee's realtime mix is a separate path from its recording (Meet-tab WebAudio + `MediaStreamTrackProcessor` in `google_meet_chromedriver_payload.js` vs ffmpeg+pulse), and it underruns with zeros when the VM's Chrome starves. Mitigations in place for 71: the Tester (listener) gets mixed audio only — no per-participant audio/video sockets (`routes/attendee.ts`), audio-only mp3 recording for the Tester, whisper-server reniced; and measurement: `RelayHub` counts holes >250 ms by the vendor's `timestamp_ms` (`GET /api/meeting/recall/relay-status/:id` → `audio.{chunks,gaps,gapMs}`), the page heartbeat carries `heardMs/zeroFrames/gaps`, and the harness prints both as `character's ears continuous` rows |
| 71 | **6 / 8 cues PASS**, `third` FAIL, `ask2` FAIL, `bargein` PARTIAL, `character's ears continuous (vendor → broker)` **DEGRADED** (15 holes >250 ms totalling 6.9 s), (broker → page) PASS (249.8 s in 27 184 frames, 10 all-zero), vendor transcript PASS (6/20 by Yui) | admitted at 205 s (10:24 JST). **Contaminated: the admitter's microphone was open** with a television behind it — Meet's captions carry `shuhei horio` at T0+11.7 s (11.6 s of 「だから、赤ちゃんのマイナ…」), +29.5 s, +228 s (「冷たいね」, 6.7 s) and +278 s, and the agent's dumps are that chatter (「マイナンバーというの大体の年収は…」「服濡れちゃ濡れてるい」, whisper's 「ご視聴ありがとうございました」 for noise). Consequences: the greeting was sanctioned at +14.2 s and cut after one frame by the host's voice (+16.8 s); `ask1` was recognised whole (「ゆい、今日の予定を教えて」 → `turn=vocative` at +70.4 s) and the answer cut after two frames by a 2.7 s 「あ.」 from the open mic — the barge-in path doing what rule 7 says; `ask2` (Tester +225 s) overlapped the host's 「冷たいね」 (+228 s) and the mix transcribed as 「冷めたいねそな感じ」, no name; `followup` PASS with 「来週までに終わる作業についてですが、どの作業のことか教えていただけますか？」 (spoken 6.1 s, stretched ×1.65 by the VM). **`third` exposed a real weakness**: the Tester's 「ゆいが昨日そう言ってたよね」 was correctly ignored (+141 s, `name mentioned`), but at +149.9 s the television's 「濡れちゃ濡れてるい」 became an `engaged follow-up` and was answered — the page attributed each agent line to *the last participant stream to go active*, and the host's flickering mic had taken the Tester's question, so the host's noise was 'the person she answered'. Fixed: the Attendee connector reports each participant's loudness (`speech_level`, dBFS, ≤10 Hz), the page keeps a 20 s ledger and attributes an utterance to the stream carrying ≥3× the runner-up's energy while the recogniser's VAD was open, falling back to the old guess otherwise (`AttendeeConnector`, `MeetingSessionController.attribute`, 3 tests: 334/334 in the touched packages). Marker `DEGRADED_BY_OPEN_MIC`; the vendor-side holes (6.9 s) persist after the load relief and remain `DEGRADED_BY_HOST_CPU` |
| 72–74 | `BLOCKED_BY_NO_ADMITTER` ×3 | 10:37–11:06 JST (04 Sep), each knock expiring at Meet's ~10 min limit (`Tester=fatal_error` at 636–666 s). 72 and 73 were the knock loop relaunching — the opposite of the one-admission rule the gate is run under (「一度の入室で全てのテストを行って確認してください」), so the loop was stopped and the harness grew `KEEP_ROOM=1`: after the script the bots stay in the call, `<run dir>/rerun` repeats the eight cues on the same admission (`report-passN.json` per pass), `stop` leaves. Run 74 was the first KEEP_ROOM knock; the next one goes out only when the admitter says they are at the room |
| sim 47 | **run 71's room, offline** — `host chatter never earns a turn (loudness attribution)` **PASS** (3 turns: `joined`, `vocative` 「ユイ、これはどう思う？」, `engaged follow-up` 「ちょっと待って、その前にこっちの話を先にさせて。」, all attributed to the Tester); `ask1` / `ask2` lost, every answer cut | 11:41 JST (04 Sep), no meeting: `attendee-sim.mjs` grew `NOISE=<wav> NOISE_GAIN NOISE_PARTICIPANT` — a second participant whose own microphone (run 71's host chatter, cut from the agent's dumps and looped, 270 s) is mixed into the room at gain 0.2 and also delivered on its own per-participant stream, exactly the shape of an admitter's open mic. The chatter was transcribed 30-odd times and attributed to `participant_sim_host` every time (first transcript 「マイナンバーというの大体の年収は…」 → host); no `engaged follow-up` came from it — the run 71 `third` failure does not reproduce. What the attribution cannot fix, and this room shows plainly: **the ears are the vendor's mix**, so when the chatter overlaps a question the recogniser hears one sentence — 「マイナンバーというの大体の**今日の予定を教えて**、今」 (ask1), 「マイナンバーとい**今どう思う**の年はそれぐらい」 (ask2) — and the name never reaches the policy; and the chatter is user speech to the barge-in, so all three answers were cut (4.6 s spoken in 300 s). Neither is a bug in the turn logic: they are what a mixed stream is. The lever, if open-mic rooms must be survived, is to feed the recogniser from the per-participant streams (one recogniser per active speaker, the mix kept only as a fallback) and to let the barge-in ask *who* is talking — an architecture change, not a fix, noted under open items. `pnpm reality:attendee:sim` with `AUDIO=gate-script-16k.wav NOISE=host-chatter-16k.wav NOISE_GAIN=0.2 SECONDS=300 PROACTIVITY=addressed_only` |
| 75 | **one admission, four passes** (`KEEP_ROOM=1`, 12:25–12:59 JST, 04 Sep). Pass 1 **5 / 8** (ask1, followup, bargein FAIL — the ears), pass 2 5 / 8, pass 3 **conversation whole** (ask1, followup, bargein-question, ask2 all answered in full; third FAIL), pass 4 **conversation whole** (third PASS). `character's ears continuous (vendor → broker)` DEGRADED: 343 holes, 178 s over 34 min — but **0 new holes in the 5 min after the cleanup below**. `room heard the character (vendor transcript)` FAIL 0/72, `answers as sound` UNKNOWN — see the Tester's ears | Admitted at 167 s (12:25 JST). **Two things found, one fixed in the room.** (1) *The ears' holes are memory, not CPU*: the Attendee worker held **eight** Chromium browsers for two bots — six were chromedriver + Chromium pairs left behind by expired knocks (18:00 UTC the day before, and runs 72 / 73 / 74 at 01:37 / 01:38 / 01:51 UTC), never cleaned up after `fatal_error`; the VM (12 GB) had swap at 1023 / 1023 MB, and the realtime capture zero-fills when the worker stalls (run 70's mechanism). The admitter killed the six stale pairs at ~12:45 JST (`docker exec … kill -TERM`, the assistant's own attempt was blocked by the auto-mode classifier): used 8572 → 7254 MB, swap 1023 → 690, Chromium 10 → 4, and Yui's hole counter stood still (297 → 297) through pass 3 while the agent's transcripts turned from fragments (「できた？」「今日のゆ日です」) into whole lines (「見たよ、三ページ目の数字が少し気になったかな。」「あそこは後で直しておくね。」「ありがとう、助かる。」). Marker: `DEGRADED_BY_HOST_MEMORY` — and a pre-flight rule: count Chromium in the worker before a knock. (2) *The Tester's ears died*: its recording (`tester.mp3`, 2064 s) is room sound until offset 1188 s = **12:44:58 JST**, then digital silence (−91 dB mean) for the rest of the run, its own cue playback excepted — while the room still had sound (the host's captions run to 12:45:21) and the admitter heard Yui speak (「聞こえております」). So every `audible` / `heard her` / `answers as sound` verdict from pass 3 on is void, `bargein` could not be timed (cut-in fell back to +23 s, after the answer), and the vendor transcript carries no Yui line (0/72, where run 71 had 6/20 — unexplained, the admitter heard her). The silence begins within a minute of the cleanup; correlated, cause not established. (3) *The admitter's microphone was open again* until ~12:45 (a television: 「戦争映画だって」「雨降ってる？」…, 37 caption lines by the host) — pass 1–2 `heard` figures are that television, and one turn went to it: `vocative (sound-alike)` on 「い？」 from `devices/559` (the host). The attribution held everywhere else (every other turn → `devices/561`, the Tester). **What the character said when it heard whole sentences** (passes 3–4, from `spoke` events): 「今日の予定については、手元に情報がないので分かりません。ただ、昨日話に出ていた資料の三ページ目の数字の修正について、確認しておきたいと思います。」(12.8 s) · 「来週までに終わるかどうかは、タスクの優先順位によって変わってきますね。」 · 「直前の話題は、資料の三ページ目の数字の修正のことだと思います。その修正は、作業の優先順位を考える上で重要だと思いますね。」 (the demonstrative resolved to the room). **What still needs work** (the next fixes): a garbled fragment answered in full — 「ゆい英坊を思う？」 → 「英坊さんの考えについては…」, 「とれ？」 (ask2, misheard) → 「とれさんの予定については、手元に情報がないので分かりません…」 — a nonsense word must not become a person; 「ちょっと待って、その前にこっちの話を先にさせて」 got a 9.3 s reply where 「はい、どうぞ」 was the answer; pass 3 `third` with the name dropped by STT (「が、昨日そう言ってたよね」) was answered as a follow-up of the engaged speaker. Report `report.json`, `report-pass1..4.json`, `tester.mp3` in `rcai-auto-1788492135642` |
| 76 | **BLOCKED_BY_BOT_HOST** — the Tester never left `joining` in 300 s; Yui knocked (`bot_3FkEMU109eYbzvdu`) | 13:57 JST (04 Sep). First launch refused (`TESTER_RESOLUTION=360p`: the self-hosted API takes `1080p` / `720p` only); the relaunch (720p, Tester `mp3`) put Yui on the door but the Tester's `run_bot` task, received by the worker at 04:57:46 UTC, only reached "Launching bot" at 05:00:30 — 2 m 44 s later, by the scheduler's `restart_bot_pod` — inside a worker with **70 leaked Xvfb** (2.9 GB) and the celery pool from before run 75's cleanup. `docker restart attendee-attendee-worker-local-1`: Xvfb 0, swap 747 → 35 MB, 8.5 GB available. Pre-flight now also counts Xvfb. No pass |
| 77 | **one admission, one pass — 4 / 8**, `ADMIT_TIMEOUT=600`, both bots in at **28 s** (14:06 JST, 04 Sep). greet PASS, chat PASS, third PASS, silence PASS; **ask1 / followup / ask2 FAIL — the ears again, with the host's memory fine**; bargein PARTIAL (`interrupted=0`). `character's ears continuous (vendor → broker)` DEGRADED: **139 holes, 87.6 s in five minutes**; (broker → page) 14 604 of 16 644 frames exact zeros; `tester's ear alive` DEGRADED (page sent 13.9 s, the Tester captured 1.2 s) | The freshly restarted worker (Xvfb 0, swap 35 MB, 8.5 GB free) took the bots in 28 s and still zero-filled the character's ears: run 75's memory finding was real, but not the whole cause. The agent's utterance dumps say exactly what reached the recogniser — **ask1 arrived as 「メになったた明日？」, 4.14 s of audio with 1.48 s of exact zeros inside it**; followup and ask2 produced no utterance at all (the VAD saw nothing); the two lines that came through whole were recognised whole — 「ユイ、これはどう思う？」 (turn at +181 s, `vocative`, attributed to the Tester `devices/564`) and 「ちょっと待って、その前にこっちの前にさせて。」 (`engaged follow-up`). **The yield fix from run 75 held in the room**: that line got 「はい、どうぞ。」 in 1.73 s (before: a 9.3 s opinion). The demonstrative question, with only garble in the context (「目月になったか?あそ」「ご視聴ありがとうございました」), was answered 「目月さんの件のことでしょうか？新しい役割について…」 — a mishearing made a person again (open item, recogniser-side). Greeting 「こんにちは、Yuiです。Yuiと声をかけていただければ返事しますね。」 at +20 s; the vendor transcript carries 4/13 lines by Yui, so the room did hear her. **What was different from run 75's clean passes — found in the launch lines, not measured**: run 75 was `YUI_RECORDING_FORMAT=mp3 YUI_PAGE_FPS=15`; run 77 was launched without either, so Yui's bot was recording **1080p 30 fps via `ffmpeg x11grab`** in the worker (the vendor's mp4 default) and the avatar page rendered at 58 fps into the camera. And the vendor's `timestamp_ms` is `time.time()` at packaging in the bot's Python (`websocket_payloads.py`), not a media clock: a 250 ms hole is 250 ms in which the bot process received nothing from its Chromium, and an all-zero chunk is Chromium's audio graph delivering zeros — both starvation inside the bot, which the extra encode fits. VM CPU/memory were read only after the bots left (low). Next knock: run 75's configuration again (`YUI_RECORDING_FORMAT=mp3 YUI_PAGE_FPS=15`; the path harness → broker `recording_settings.format` verified in `routes/attendee.ts`), the broker's new hole log (last 64 holes with arrival times, `zeroChunks` at the broker) printed per pass against T0, `docker stats` sampled every 15 s during the pass. **Lost to the operator**: the KEEP_ROOM wait was left idle for 25 min while reporting and the Tester auto-left on silence (`auto_leave_silence` 05:36 UTC), ending the admission — passes must be rerun back-to-back. Report `report-pass1.json`, `report.json`, `tester.mp3` in `rcai-auto-1788498338832`; agent dumps `utt-async4/` |
| 94 | **One admission, four passes — 8 / 8 · 7 / 7 · 7 / 7 · 7 / 7, every cue PASS** (run 90's launch line, llama-server `-c 16384` + warm-up, agent 78c7e2e; 23:20–23:43 JST, 05 Sep; admitted in **91 s**, Yui 51 s before the Tester so the greeting was hers alone). `bargein` PASS ×4 (cut-in +7.0–7.5 s → `interrupted` +9.6–10.3 s, 0.0 s audible after), `ask1` / `followup` / `ask2` answered in full ×4, `third` / `chat` / `silence` quiet ×4, no name echo, vendor transcript **PASS 24 / 62**. Every first token 245–474 ms **except the barge-in yield turns of passes 3 and 4: 5185 / 4935 ms** — the llama log names it: the fold (deferred, so it now starts *during playback*) landed on another slot while the conversation slot was idle, llama-server's default `--clear-idle` saved that idle slot to the host cache and cleared its KV, the barge-in cancelled the fold, and the yield turn's prompt no longer matched the saved one (its prefix diverges where the reply was cut: the cache holds the whole generated reply, the history what was heard) → `failed to load prompt from cache`, **3318 / 3291 tokens re-read in 5.1 / 4.9 s**. Run 92's 4.6 s was the same mechanism, not the KV size. Fixed in `local-stack.sh`: `--no-clear-idle` — verified against the server (a 1456-token prompt, a 558-token prompt on another slot, then the first plus a tail: 9 tokens re-read, 102 ms, no save/clear). Not yet heard in a room. Supertonic 1011 / 1046 ms twice, otherwise ≤ 700 ms; `answers as sound` DEGRADED on muffled f99 1656–2469 Hz (seven replies) and one 1251 ms gap; ears (vendor → broker) DEGRADED 5 holes / 3.5 s, (broker → page) 96 arrival holes. Host disk 14 → 11 → 13 GiB free across the run (temporary files, not growth). `spoke after the window` filled the four empty `reply=""` (e3bbddd). Reports in `rcai-auto-1788618089617`; `auto-run94.log`, agent `agent-run91.log` |
| 93 | **8 / 8 · 7 / 7, then `BLOCKED_BY_BOT_HOST` mid-pass 3 — the host disk** (run 90's launch line, llama-server at `-c 16384` with the warm-up; 22:05 JST, 05 Sep; admitted in **25 s**). Greeting at 10.3 s with **first token 234 ms** (7.9 s in run 92: the warm-up did its job — the session's 1101-token prompt read in 1.59 s against 9.05 s), pass 1 **8 / 8**, pass 2 **7 / 7** (`bargein` cut-in +7.1–7.4 s → `interrupted` +9.8–11.7 s), pass 3 `chat` / `ask1` / `followup` / `third` PASS and then, at the `bargein` cue, `fetch failed ECONNREFUSED 127.0.0.1:8000`: Attendee's API was gone. The Docker VM had logged `I/O error, dev vda … WRITE` and `EXT4-fs … potential data loss` at 22:19:13 and stopped itself at 22:19:53 — its sparse disk image could not grow on a host disk at **98 %** (5.4 GiB free); run 87's failure class. The harness died on the first throw with no reports written (fixed: d5eabb9, a vendor that cannot be reached fails the call and the pass keeps its verdicts). The fold in pass 2 ran 7.97 s after synthesis and re-warmed in 3.1 s; no eviction seen on the new context. After the admitter freed 12 GiB (17 GiB free) Docker Desktop was restarted and the containers `docker start`ed; the VM sees a 224 GB virtual disk with 193 GB "free", so the host's free space is the only real bound — watch it before every knock. `auto-run93.log`, agent `agent-run91.log` |
| 92 | **One admission, four passes — 8 / 8 · 7 / 7 · 6 / 7 · 7 / 7 on the staged cut and the deferred fold** (run 90's launch line, agent 78c7e2e, llama-server from `local-stack.sh` at `-c 4096`; 19:53–20:40 JST, 05 Sep; admitted at the **third knock, 1601 s** after launch — the first two expired at Meet's limit and park mode restarted the worker (28 leaked Chromium) before the third). Greeting at 5.9 s but **first token 7.9 s**: llama-server had been started minutes before and its first requests were cold (27 tokens in 7.8 s at the pre-flight, the 1101-token warm in 9.0 s; the same size read in 2.5 s afterwards) — the greeting waited behind the warm. Passes: `ask1` / `followup` / `ask2` answered in full ×4, `bargein` PASS ×3 (cut-in +6.7–7.4 s → `interrupted` +9.1–10.5 s, 0.0 s audible after) and **PARTIAL by timing in pass 3** (the 7.0 s reply had ended 1.6 s before the cut-in reached the recogniser — nothing to stop; the yield 「はい。」 followed), `third` / `chat` / `silence` quiet ×4, no name echo ×4. **The staged cut worked as designed:** the turn that crossed the budget no longer re-reads the window (196–199 tokens, 360–406 ms, where run 90 paid 763–806 tokens / 1.3–1.6 s), the fold ran after the reply's synthesis (8.6 / 10.7 / 11.3 s, no Supertonic slowdown beside it: 180–680 ms a phrase during folds), and the re-warm landed before the next turn every time (next first token 327–364 ms). **What it exposed:** llama-server's `-c 4096` is one *unified* KV shared by its four auto slots; a 2907-token conversation prompt plus a 958-token fold forced the conversation slot out to the host prompt cache (`saving idle slot to prompt cache` → `failed to load prompt from cache`), and the barge-in yield turn that cancelled that fold re-read **3100 tokens in 4.5 s** (first token 4.6 s, pass 3) — the prompt had grown to the 1.5-budget cap while the cut waited. Run 90's server had been started by hand with a larger context, which is why it never showed this. Fixed in `local-stack.sh`: `-c 16384` by default and two warm-up completions after the start (measured after the restart: 11 tokens 131 ms, 436 tokens 622 ms). In-room Supertonic 205–950 ms a phrase, one 2080 ms (34 ch, `ask2` pass 4, no fold running — host CPU). Ears (vendor → broker) DEGRADED 9 holes / 6.5 s over 120 130 chunks (passes 3–4 carried 12.6 s of the pass-level holes); `answers as sound` DEGRADED on muffled f99 1844–2219 Hz (six replies) and one 671 ms gap; vendor transcript **PASS 21 / 61** (Yui's transcription_state `failed` again, the Tester's captions carried her). Reports `report-pass1..4.json`, `report.json`, `tester.mp3` in `rcai-auto-1788605602249`; `auto-run92.log`, agent `agent-run91.log` (same process) |
| 91 | **VOID — `turn=none` ×16, the character never reached the agent** (run 90's launch line; 19:01–19:37 JST, 05 Sep; admitted at 446 s). The host had rebooted at 18:43; `meet-setup.sh` re-opened the broker and bot-page tunnels, every pre-flight passed (agent answered locally, bot page built, worker clean), the bots joined, the page loaded — and `RECALL_AGENT_PUBLIC_URL` still named the agent's *third* tunnel, opened by hand before the reboot and gone with it: the hostname no longer resolved, the page's WebSocket to the agent never opened, and four passes ran with a deaf and mute character (greeting none, no `turn`, `relay closed 1006 after 0 chunks` ×3 before the admission). Fixed (42a885b): the harness refuses to knock unless `RECALL_PUBLIC_URL` and `RECALL_AGENT_PUBLIC_URL` answer `/health` from the host (`BLOCKED_BY_PUBLIC_URL`), and `meet-setup.sh` opens all three tunnels, waits for the hostnames to resolve and reports each. Also seen: a fresh quick-tunnel hostname that the host's resolver had cached as NXDOMAIN never came back (web tunnel, 4+ minutes) — a new tunnel did; `pnpm dev` in `services/agent` is `tsx watch` and must not serve a room run. `auto-run91.log` |
| 90 | **One admission, four passes — 7 / 8, then 7 / 7 ×3; the reply path measured in the room** (run 89's launch line, agent on the int8 voice / single ORT / 4 threads / held turn of 5e78239–3df20b8; 17:56–18:17 JST, 05 Sep; both bots in at **34 s**, worker Xvfb 2 · Chromium 0 before the knock). Pass 1 **7 / 8** — `bargein` PARTIAL: cut-in +7.2 s → `interrupted` +10.3 s, 0.0 s audible 1.5–5 s after the cut-in, but 6.3 s audible later in the window (Yui herself said only 「はい、どうぞ。」, 0.9 s; the agent had heard its own greeting through the admitter's open mic at 08:56 Z, so the extra sound may be that mic — unverified; passes 2–4 read 0.0 s). Passes 2–4 **7 / 7**, `rerun` within seconds of each pass end (09:01:45 / 09:06:47 / 09:11:50 Z). Greeting: text → first token **242 ms** → first audio **450 ms**. Answers: `ask1` ×4 (「今日の予定については、現時点では手元に情報がありません。」), `followup` ×4 as an engaged follow-up, `bargein` cut-in +7.0–7.2 s → `interrupted` +9.7–12.3 s, `ask2` ×4, `third` / `chat` / `silence` quiet ×4, no name echo ×4. Turn → first token 351–460 ms and first phrase → first audio 259–716 ms on a warm prompt; **in-room Supertonic 277–999 ms a phrase** (2–4× the sims: the host runs the Attendee VM at 221–494 % CPU) with 1.4 s ×2 under the fold (pass 3) and one 2.4 s under barge-in load (pass 2). **Two cold prompts a half-window** (each pass, llama log): the halving cut at compose (763–806 tokens re-read, first token 1.3–1.6 s) and the fold's notes a turn later (1008–1283 tokens, 2.3–2.5 s, the fold itself 6–8 s on another slot, the re-warm 1.4–1.9 s not always landing before the next turn) — fixed below (78c7e2e). **Rescore hallucination propagated:** on holey chat fragments whisper turned 「めた。」 into 「メタル」 and 「ア定ージ目…」 into 「なんてエリメが…」 and 「エリメ」 surfaced in two pass-1 replies (「エリメの件についてですが」); pass 2's guard dropped 「メタリオス」 but kept 「暫定時目の数理」. Ears (vendor → broker) **DEGRADED**: 16 holes / 7.5 s over 120 819 chunks (run 89: 6 / 2.0 s), 9 of them / 4.5 s during pass 1's chat cues; (broker → page) 24 arrival holes. `answers as sound` DEGRADED: gaps 1.3 s (`followup`, pass 3) and 1.0 s (`ask1`, pass 4), muffled f99 2000–2250 Hz on three pass-1/2 replies; `DEGRADED_BY_HOST_CPU`, unchanged. Vendor transcript **FAIL 0 / 0** — Attendee's caption post-processing ended `transcription_state: failed` on the Tester (as in run 88; run 89 passed) — the vendor's transcriber, not the room. Eight `spoke` reports filed as `reply=""` (audio present) — the harness re-read late `spoke` events only at the leave; per pass from e3bbddd. Reports `report-pass1..4.json`, `report.json`, `tester.mp3` in `rcai-auto-1788598564282`; `auto-run90.log`, agent `agent-async10.log` |
| 89 | **One admission, four passes — every cue PASS, on the built bot page** (run 88's launch line, `KEEP_ROOM=1`, bot page = `vite preview --port 5180` behind its own quick tunnel, pre-flight `built app, no HMR client`; 10:43–11:04 JST, 05 Sep; both bots in at **31 s**, worker Xvfb 0 · Chromium 0 before the knock). Pass 1 **8 / 8**, passes 2–4 **7 / 7**; `rerun` within seconds of each pass end (01:43:51 / 01:48:53 / 01:53:55 / 01:58:57 Z). Twenty-one minutes in the room with **no page reload, no `agent_closed`, no vendor leave** — run 88's two failure classes did not recur (the inaudible stretch of run 88 pass 2 did not reappear either; still unexplained, one clean run is not a fix). Greeting at **7.4 s** (14.0 s in run 88). `ask1` answered in full ×4 (heard 5.6–6.6 s, 「今日の予定については、特に決まっていることはありません。ただ、資料の修正作業を進めていきたいと考えています。」), `followup` as an engaged follow-up ×4 (「その修正作業が来週までに終わるかどうかは、現状ではまだ確定していません。」), `bargein` PASS ×4 (cut-in +7.9 / +8.5 / +7.1 / +6.9 s → `interrupted` +11.5 / +11.5 / +11.0 / +10.8 s, 0.0 s audible after; cut replies read 「3ページ目の数理の修正についてですね。…」 — 「3ページ目」 heard right in all four passes, 「数理」 for 「数字」 in three), `ask2` ×4 (「資料の修正作業を優先して進めるのが一番だと思います。」), `third` / `chat` / `silence` quiet ×4, `reply does not parrot the name` PASS ×4. Ears (vendor → broker) **PASS**: 6 holes / 2.0 s over 120 131 chunks for the whole admission (run 84 had 27 / 9.0 s); (broker → page) DEGRADED on 7 arrival holes. Vendor transcript **PASS** 24 / 63 utterances by Yui (Meet's captions read her greeting and both answers). **Degradations, the sound not the words:** `answers as sound` DEGRADED — `ask2` stretched ×1.46 / ×1.48 with 2.6 s gaps in passes 2–3, `followup` gaps 0.7–1.6 s, muffled f99 1875–1969 Hz on two `ask2` replies; turn → audible 5–7 s, replies 5–8 s long. `DEGRADED_BY_HOST_CPU` for the gaps, unchanged. Two `spoke` reports did not reach the harness (pass 1 / 2 `ask1` `reply=""`, audio present) — reporting, not the character. Reports `report-pass1..4.json`, `report.json`, `tester.mp3` in `rcai-auto-1788572591424`; `auto-run89.log` |
| 88 | **One admission, four passes — 8 / 8, then 4 / 7 · 5 / 7 · 3 / 7; two new failure classes, one fixed** (run 84's launch line, `KEEP_ROOM=1`, agent on the rescore guard of 3cb8700; 07:45–08:06 JST, 05 Sep; both bots in at **27 s**, worker restarted before the knock — Xvfb 0 · Chromium 0). Pass 1 **8 / 8**: greeting 14.0 s, `ask1` 5.7 s (gap 220 ms), `followup` 5.9 s, `bargein` cut-in +7.9 s, `ask2` 4.0 s ×1.01, ears 3 holes / 1.2 s. Pass 2 (T0 22:51:12 Z): **the page ↔ agent reconnect fired in a room for the first time** — close code 1006 twenty seconds before the pass, a new provider up in 1938 ms on the first attempt (`agent_closed` → `agent_reconnected`), and `chat` / `third` / `silence` / `ask2` PASS behind it (`ask2` 5.0 s ×1.03, gap 309 ms: 「資料の数理の部分は、確認して修正を進めるのが一番良いと思いますよ。」). But `ask1` / `followup` / `bargein` PARTIAL: **the page spoke ~10 s each and the Tester heard 0.0 s** (`heard her none`, cut-in +23.1 s) for two and a half minutes, then audio returned by itself — no trace in the streamer's or the worker's logs, no hole on the relay; unexplained (leading guess: the streamer → worker audio leg or PulseAudio capture under host load). Pass 3: `ask1` PASS 9.2 s (⚠ muffled, f99 = 2000 Hz), `followup` PASS 7.1 s, then **the bot page reloaded itself at 22:59:00 Z** and `bargein` / `ask2` FAIL; pass 4 `ask1` / `followup` / `bargein` / `ask2` FAIL — Yui deaf and mute for the rest of the admission (relay `clients: 0`). Diagnosed live over Chromium's DevTools inside the webpage-streamer container: a second `POST /offer_meeting_audio`, a fresh console starting `[vite] connecting…` with no `[rcai:bot]` line after it, `__rcaiAudio.live()` = 0 contexts, no Vite server event, no Attendee navigation, no crash report — **the Vite dev client's reload-after-WebSocket-loss** (`client.mjs` `waitForSuccessfulPing` → `location.reload()`, which `server.hmr: false` does not disable) after the quick tunnel dropped its HMR socket; the reloaded page cannot re-activate because the activation token is single-use. Fixed operationally and mechanically: the bot page is now the **built app served by `vite preview --port 5180`** (no HMR client), `meet-setup.sh` prefers 5180 and warns on 5173, and the harness pre-flight fetches the bot page and stops with `BLOCKED_BY_DEV_BOT_PAGE` when it carries `/@vite/client` (`ALLOW_DEV_BOT_PAGE=1` overrides); the built page passed the offline sim in bot mode (sim 50: relay + agent sockets only, no Vite socket, 245 frames spoken). Final rows: ears (vendor → broker) **PASS** (5 holes / 1.7 s), (broker → page) DEGRADED (18 arrival holes, the reload among them), vendor transcript FAIL (0 / 0 — Meet gave no captions this run), Tester recording PASS. **Recogniser finding:** pass 2 heard 「3ページ目」 as 「3定リ目」 and the reply followed it (「3定リ目の数理のことだと思います」); pass 3 read it right. No 「メタリオ」 recurrence (the guard had nothing to drop — both passes agreed on 「メタよ」). Replies are now ~10 s long — rich, but turn → audible sits at 6–8 s. Reports `report-pass1..3.json`, `report.json`, `tester.mp3` in `rcai-auto-1788561935860`; `auto-run88.log` |
| 87 | **BLOCKED_BY_BOT_HOST** — the harness crashed at the knock: `fetch failed … HeadersTimeoutError` against the self-hosted API | 07:21–07:28 JST (05 Sep). The Docker Desktop VM had stalled — the host disk had filled (old harness run directories under `$TMPDIR`); after deleting them (~5.7 GiB free) and restarting the worker the API answered again. `state()` in the harness now times out at 15 s and reports the error instead of throwing. |
| 85–86 | **BLOCKED_BY_NO_ADMITTER ×2, park mode verified** — six knocks each, none admitted | 02:43–03:44 and 03:45–04:45 JST (05 Sep), `ADMIT_TIMEOUT=3600 PARK_RESTART_WORKER=1`. The re-knock landed in run 84 did what it was built for: each knock died at Meet's ~10 min limit (`fatal_error` / `joining`), the harness restarted the worker (Xvfb 2–3 · Chromium 28–42 leaked per expired knock) and knocked again until the budget ran out. Nobody was in the room to admit — the bots were parked at the door on the user's request (「あらかじめミーティングにボットを参加させておいて…」). |
| 84 | **One admission, four passes — all PASS** (run 78's launch line, `KEEP_ROOM=1`, broker on the 3600 s silence timeout — stored value confirmed on the bot via the vendor's Django shell; 02:13–02:35 JST, 05 Sep; both bots in at **53 s**, worker restarted before the knock — 2 leaked Xvfb, 0 after). Pass 1 **8 / 8**, passes 2–4 **7 / 7** (greeting is once per admission), `rerun` fired within seconds of each pass end, 17:14:42 / 17:19:57 / 17:24:59 / 17:30:01 Z; `bargein` PASS in all four (cut-in +7.6 / +11.1 / +7.6 / +9.5 s, 0.0 s audible 1.5–5 s after), `third` and `silence` quiet ×4, no `agent_closed`, vendor transcript PASS. Twenty-one minutes in one room with no vendor leave. **Degradations, all on the bot host:** greeting at **13.5 s** (5.8 s in run 83); the ears' holes grew pass over pass — cumulative 7 / 2.1 s → 10 / 3.3 s → 21 / 7.0 s → 27 / 9.0 s (final row `character's ears continuous (vendor → broker)` DEGRADED, `broker → page` 26 arrival holes) — and the mid-reply gaps with them (worst gap 1.0 → 1.4 → 3.0 → 4.3 s; `answers as sound` DEGRADED, pass 4 `followup` stretched ×1.33 with underruns), so pass 4's `ask1` / `followup` / `ask2` were PASS as text but `spoke after the window`. Same host carrying Attendee's two Chromiums, llama, whisper and the page, and the trend is the load, not the character: `DEGRADED_BY_HOST_CPU`, unchanged. **Wrong-name finding (character quality, not the gate):** the second-pass recogniser turned the 0.6 s fragment 「見たよ。」 (the Tester's chat line split at the pause) into 「メタリオ」 in three separate runs, and 「昨日そう言ってたよね」 into 「イノースを言ってたよね」; both landed in the 【会議の直近の発言】 context and the referent-less `bargein` cue 「これはどう思う？」 made her reach for them — 「イノースのことでしょうか？」 (pass 1), 「メタリオさんが直前に話されていた…」 (passes 2–4, near-verbatim repeats: her own earlier answer in the history steered the next). The address itself was not parroted (`reply does not parrot the name` PASS ×4). Fix to follow in the agent: a second pass that disagrees wholesale with the streaming text on a sub-second clip is a whisper hallucination and must be dropped (「ご視聴ありがとうございました」 also appeared once, the textbook case). Also landed this run, unverified in a room: the harness re-knocks when a knock dies unadmitted within `ADMIT_TIMEOUT` (`PARK_RESTART_WORKER=1` restarts a leaked worker between knocks), so the bots can be sent to the door before the tester is ready. Reports `report-pass1..4.json`, `report.json`, `tester.mp3` in `rcai-auto-1788542022304`; `auto-run84.log` |
| 83 | **One admission, two passes** (run 78's launch line, `KEEP_ROOM=1`; 01:18–01:55 JST, 05 Sep; both bots in at **37 s**, worker restarted before the knock — 4 leaked Xvfb, 0 after). Pass 1 **8 / 8** — the first clean pass since the eight-cue script: greeting at 5.8 s, `ask1` / `followup` / `ask2` answered in full, `bargein` PASS (`heard her +5.8s`, cut-in +7.3 s, 0.0 s audible 1.5–5 s after), `third` and `silence` quiet; `character's ears continuous (vendor → broker)` **PASS** — 2 holes / 0.8 s; vendor transcript PASS. Pass 2 **3 / 8** (`ask1` / `followup` / `bargein` / `ask2` FAIL, `heard=0.0s`): **`DEGRADED_BY_VENDOR_AUTO_LEAVE`** | **Pass 2 was not the character — Yui was no longer in the room.** Attendee's webhook: `leaving` with `subCode: "auto_leave_silence"` at 16:49:28 Z, exactly 1800 s after `joined_meeting` (16:19:28 Z); the worker log: `Silence detection activated after 1200 seconds` (16:39:28 Z) then `Auto-leaving meeting because there was no audio for 600 seconds`. The vendor's default `automatic_leave_settings` arm 1200 s after joining and leave after 600 s without a single non-zero audio frame — a recorder's rule, and the 25 quiet minutes between the passes (the harness's monitor was silent on a buffered pipe and the `rerun` came late, at 16:49:33 Z, five seconds after the leave) met it. The Tester's cues in pass 2 played to a room without her (the Tester's worker shows `Syncing media requests` at 16:49:35 Z onward, Yui's relay `vendor:false`, `clients:0`). The reconnect from run 81 did not fire because nothing closed: the agent socket was fine, the bot itself left. **Fixed:** the join payload now carries `automatic_leave_settings` with `silence_timeout_seconds: 3600` (a participant sits through a quiet stretch; an hour of no sound is where "nobody is talking" more likely means "nobody is here"), and the join body takes `automaticLeave` overrides for silence / activation / max uptime (2 tests). The broker was restarted on the new code. Also new this run: `session_closed.reason` carries the WebSocket close code (`ws close 1006 …`) through `agent_closed`, so a run-81-style close will name itself. Reports `report-pass1..2.json`, `report.json`, `tester.mp3` in `rcai-auto-1788538732595`; `auto-run83.log` |
| 81–82 | **81: one admission, two passes** (run 78's launch line, `KEEP_ROOM=1`; 17:56–18:08 JST, 04 Sep; both bots in at **31 s**, worker restarted before the knock — 4 leaked Xvfb). Pass 1 **7 / 8** (`bargein` PARTIAL), pass 2 **0 / 5** (`ask1` / `followup` / `bargein` / `ask2` FAIL: `heard=0.0s`, nothing reached the recogniser); `character's ears continuous (vendor → broker)` **PASS** — 4 holes / 1.2 s over both passes (0.3 s each); vendor transcript PASS. **82: `BLOCKED_BY_NO_ADMITTER`** (18:12–18:22 JST, 600 s, nobody in the room) | **Pass 2 was the AI's socket, not the ears.** The last utterance the agent saw was the chat cue's 「ありがとう、助かる。」 at 09:03:19 Z; every cue after it reached the broker as sound (the bargein cue's window showed 8.3 s of non-zero chunks on Yui's relay at 09:05:51–09:06:00) and the page kept its relay client, but `lsof -iTCP:8788` had no established connection left — the page ↔ agent WebSocket had closed, silently on both sides (nothing in the agent log, `ws.on("close")` only stops the session), and `LocalProvider` only emits `session_closed`, which nothing on the page handled. **Fixed:** `MeetingSessionController` now treats a `session_closed` it did not ask for as a lost session — the turn in flight is given up as an interruption, a new provider is brought up behind the same avatar and speaker with `runtime.switchProvider` (1 → 30 s backoff, until the page leaves), the mic stream re-attached for WebRTC providers, and `agent_closed` / `agent_reconnected` reported to the broker (4 tests). The cause of the close is **not known** — the quick tunnel to the agent had been up 3.5 days and answered `/health` in 0.9 s afterwards; a tunnel-side WebSocket reset is the leading guess, and the reconnect is the answer either way. **Pass 1 bargein PARTIAL**: the reply to 「ゆい、これはどう思う？」 was 6.6 s long (09:00:26–09:00:32.8), the cut-in was played at +7.7 s but reached the recogniser at ~09:00:32 (4.7 s dump at 09:00:36.7) — as the reply ended, so there was nothing to interrupt (`interrupted=0`, 0.0 s audible 1.5–5 s after); the cut-in itself was answered 「はい。」 as an engaged follow-up. The verdict depends on the reply outlasting the cut-in's ~4 s trip through the Tester and the relay; run 78's four PASSes had longer replies. Neither rescore path (withdraw / late turn, runs 79–80's fixes) fired in pass 1: the recogniser read the name right first time in every cue (「ユイが昨日そう言ってたよね。」 third person → no turn), which is the case they do not touch. Turn → first audible ≈ 6.2 s (bargein `heard her +6.2s`). Reports `report-pass1..2.json`, `report.json`, `tester.mp3` in `rcai-auto-1788512206155`; run 82 `auto-run82.log` |
| 79–80 | **79: one admission, one pass — 6 / 8** (run 78's launch line, `KEEP_ROOM=1`; 16:43–16:49 JST, 04 Sep; both bots in at **28 s**, worker pre-flight Xvfb 0 · Chromium 0 · 8.4 GB free). greet PASS (17.9 s, `now`), chat PASS, third PASS, **bargein PASS** (cut-in +7.9 s → `interrupted` +12.2 s, quiet after; cut reply read), ask2 PASS (6.6 s heard), silence PASS; **ask1 FAIL, followup FAIL** (no turn; followup consequential). **`character's ears continuous (vendor → broker)` PASS for the first time** — 3 holes / 1.5 s in a 4.5-minute pass (0.28 / 0.84 / 0.35 s); `tester's ear alive` PASS (page sent 13.5 s, the Tester captured 11.8 s). **80: `BLOCKED_BY_NO_ADMITTER`** (16:51–17:01 JST, 600 s; the admitter had left the room — knocked without a signal, a mistake not repeated) | **Ask1 was the recogniser's first reading, again — the other way round from run 78.** The streaming recogniser wrote 「唯イ寮の予定を教えて。」 (dump `2026-09-04T07-44-44-652Z`): 唯 was not one of Yui's spellings, so no address → no turn; the whisper rescore 1.2 s later read 「ゆい、今日の予定を教えて」 — the address the policy would have taken — and nothing took a turn on a rescore. Run 78 needed the rescore to *withdraw* a turn; run 79 needs it to *earn* one. Both are one mechanism, now in place: the rescore is a second opinion on the same utterance — (a) an engaged follow-up whose better reading turns out to be talk *about* the character is withdrawn while still a draft (`ParticipationPolicy.withdraw`, `detect`; `JP_THIRD_PERSON` now also matches 「そう言ってた」), (b) a line whose first reading earned nothing and whose better reading is an address by name is fed to the policy as a late turn, once, while the character is not already answering (`MeetingSessionController.secondOpinion`, 7 tests); and 唯 / 結衣 joined Yui's aliases. Not observed in a room yet: both paths only fire when the streaming recogniser drops or mangles the name, which it did in runs 78 and 79 and not in 81. Ears: with run 78's launch line the holes are now three per pass, all under a second, and the vendor → broker row passes by its own letter — the residue is bot-side load (each hole sits where the Tester's cue plays or Yui answers). Turn → first audible ≈ 6.4 s. Reports `report.json`, `tester.mp3` in `rcai-auto-1788507777364`; run 80 `auto-run80.log` |
| 78 | **one admission, four passes** (`KEEP_ROOM=1`, run 75's launch line `YUI_RECORDING_FORMAT=mp3 YUI_PAGE_FPS=15`, `ADMIT_TIMEOUT=600`; 15:50–16:20 JST, 04 Sep; both bots in at **55 s**, worker pre-flight Xvfb 2 · Chromium 0 · 8.2 GB free · swap 35 MB). Pass 1 **7 / 8** (`chat` FAIL — the greeting's own `turn`, a scoring bug fixed below), pass 2 **7 / 7** (greet N/A after pass 1), pass 3 **5 / 7** (`third` FAIL, `ask2` FAIL), pass 4 **7 / 7**. `bargein` PASS in all four passes (cut-in +1.5 s → `interrupted`, nothing audible 1.5–5 s after). `character's ears continuous (vendor → broker)` still DEGRADED by the letter of the check but **37 holes / 15.2 s in 30 minutes** (run 77: 139 / 87.6 s in five), per pass 7 / 3.0 s · 10 / 4.0 s · 10 / 3.3 s · 10 / 4.9 s, every hole 0.3–0.9 s; vendor transcript PASS (30/68 utterances by Yui); parrot PASS (4 replies read); `answers as sound` DEGRADED (gaps 1.4–4.7 s inside answers, f99 1.7–3.6 kHz) | **The launch line was the cause of run 77's ears.** With the character's 1080p30 x11grab recording off and the page at 15 fps the holes fell ~20× per minute and no answer was lost to zeros; the ones left cluster where the bot works hardest — the Tester's cue playing, Yui answering (pass 4: eight of ten between 194 s and 210 s, the bargein exchange) — with the VM at 4.0–4.3 GiB of 11.67 and no swap, CPU bursts 65–510 % (`docker stats` every 15 s). Load inside the bot, not memory; the residue is not fixable from this side of the tunnel short of a bigger worker. **Pass 1 chat**: the admitter's microphone held the floor until ~24 s (greeting deferred, `LISTENING` at 14.2 s), the greeting was said at 26.2 s — inside the chat window, whose scorer forgave the greeting's *speaking* but counted its `turn` event; the harness now filters `reason: "joined the meeting"` out of the chat/third/silence turn count. **Pass 3 third**: the recogniser dropped the name — 「ユが昨日そう言ってたよね。」 (dump `2026-09-04T07-11-56-056Z`), no name → not third person, and the Tester was the engaged party since ask1 → **`engaged follow-up`, answered, 1.7 s audible**; the whisper rescore 1 877 ms later read 「ユイが昨日そう言ってたよね」 — the reading the policy would have declined, arriving ~4 s before the answer's audio started. That is a fix at the policy: let the rescore withdraw a follow-up turn it contradicts (next commit). **Pass 3 ask2**: a 0.3 s hole at 212 s fell inside 「ゆい、今どう思う？」 → recognised 「ゆいいいと思う。」 (『と思う』 reads as third person → no turn), rescore 「ゆい、いいなと思う」 — the question itself was lost in the hole, nothing downstream could have answered it. **Latency, measured**: turn → first audible ≈ 5.9–7.0 s in every pass (bargein's `heard her +5.9/6.8/6.9/7.0 s` after a cue that itself takes ~1.5 s), which is why three of pass 4's replies were read only "after the window" — the room hears the answer, late. Lost this run: none; the room was left by `stop` after pass 4 (a code change that needs a page reload follows). Reports `report-pass1..4.json`, `report.json`, `tester.mp3` in `rcai-auto-1788504629010`; agent dumps `utt-async4/`; broker log `broker-selfhost7.log` |

What the runs settled: the character answers when the question arrives whole (22), and the failures are
the host, not the conversation — under emulation the worker's two Chromes and the streamer take the CPU the
Tester needs to deliver the question in one piece, and what Yui does say comes back stretched or muffled.
So the run that follows (30) starts with the CPU relief already in place (`YUI_PAGE_FPS=15`, 360p streamer,
no debug recording, Tester at 720p, mp3 recording), a hedged LLM (below), and the colleague persona; the
markers are `DEGRADED_BY_HOST_CPU` for a run whose cues fail with the question fragmented, and
`BLOCKED_BY_NO_ADMITTER` for one nobody admitted. If 30 is still degraded the next lever is a native arm64
Attendee image, not another prompt.

That lever is now built and knocks. `scripts/reality/attendee-selfhost/Dockerfile.arm64` (`attendee-selfhost.sh
build-arm64`, Debian bookworm's Chromium 151 + chromium-driver, Zoom SDK left out — it ships amd64 only) runs the
whole stack natively at VM load **1.0–2.4** where the Rosetta image sat at 18–24. Two things stood between it and
the Meet lobby, both in Chromium, neither in Attendee's join logic: (1) Chromium 138+ puts `ws://localhost` from a
public origin behind a Local Network Access prompt (`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`), and the
bot page's media socket is exactly that — `--disable-features=LocalNetworkAccessChecks` in `RCAI_EXTRA_CHROME_ARGS`
(a no-op on Chrome 134); (2) a WebSocket opened while the document-start payload runs made Chromium 151 drop the
navigation altogether (`driver.get` back in 0.2 s with `data:,`; bisected with a probe to the one
`new WebSocket` line — even `wss://echo.websocket.org` did it), so the fourth local patch opens the socket one
macrotask later (`WebSocketClient.connect`, `google_meet_chromedriver_payload.js`). Evidence 2026-09-03 20:25 JST,
`ADMIT_TIMEOUT=120`: both bots `name input found` → `3 audio elements are present` → `Clicking the join button` →
`UsersUpdate … 'Yui'` over the page socket, load 1.05 — i.e. knocking, on a host with CPU to spare; not admitted
only because the room was empty. Runs 30+ run on this image (`RCAI_ATTENDEE_IMAGE=attendee-attendee-app-local:arm64`).

What still blocks the gate is not the machine but the door: two runs (29, 30) knocked for the full 600 s
with nobody to admit them, and the assistant has no way to open it — the Chrome extension is not connected
here, and logging the bot into a Google account is the user's password, which the assistant never handles.
Two ways to remove the dependency on a live admitter, both the user's: (1) in the Meet's host controls set
meeting access to *Open* (「参加をリクエストしなくても参加できる」) for `uqb-ytqv-wwa`, after which every run
joins by itself; or (2) be in the room when a run starts and admit 「Yui」 and 「Tester」 within 10 min. Until
one of them happens Gate #8 stays `BLOCKED_BY_NO_ADMITTER`, and the offline gates above are the evidence.

## COMMERCIAL-GATE-04 — webhook-authoritative state

The rule is not "delete the polling API". It is: **webhooks are the only thing that moves product state,
and the direct GET survives as an admin tool** — otherwise one dropped delivery leaves a meeting stuck on
"joining" forever with no way back.

| Requirement | State | How |
|---|---|---|
| No status polling from the product UI | **PASS** | The bot page and operator UI never call it; state arrives on the relay. |
| No periodic polling in the backend happy path | **PASS** | `RecallConnector` defaults to `pollIntervalMs: 0`; the timer only starts if a deployment opts in. |
| Transitions driven by `bot.*` webhooks | **PASS** | The broker maps the events, updates the record, and pushes `bot.status_change` down the relay so clients learn without asking. |
| Duplicate delivery does not corrupt state | **PASS** | Queue de-duplicates on `webhook-id`; `shouldApplyStatus` refuses a repeat. |
| Out-of-order delivery does not go backwards | **PASS** | Status ranks are monotonic; `fatal` is the one state that always lands. Observed live: `in_call_recording` was processed before `in_call_not_recording`. |
| Bad signature → 401/403 | **PASS** | Verified against the raw body before parsing. |
| Unknown event / sub-code does not crash | **PASS** | Recorded with the reason and skipped; `describeBotFailure` still produces a message. |
| Handler re-runnable | **PASS** | Queue retries with backoff; applying is idempotent. |
| Event id stored with the update | **PASS** | Lifecycle entries carry the event, and skipped ones carry why (`event:out_of_order`). |
| Fast ACK | **PASS** | Verify → enqueue → 2xx; all work happens in the queue worker. |
| Manual reconcile, admin only | **PASS** | `POST /api/meeting/recall/bots/:id/reconcile` behind `RECALL_ADMIN_TOKEN`, monotonic like the webhook path. |
| Reconcile not reachable from normal use | **PASS** | Not called by any product code path. |
| Traceable without secrets | **PASS** | One line per delivery: bot id, meeting id, event id, event, status, sub-code, received-at, transition latency, applied, reason. |

Proved automatically: a dropped delivery leaves the record stale, reconcile recovers it, and a reconcile
that would move the state backwards is refused. Worth repeating once in a live call.

## Authenticated Enterprise (separate release)

| # | Item | State |
|---|---|---|
| 1 | Authenticated Google Meet bot | **CODE DONE, BLOCKED_BY_GOOGLE_WORKSPACE** — `RECALL_GOOGLE_LOGIN_GROUP_ID` is sent on ad-hoc and scheduled bots. Needs a **separate paid Google Workspace with org-wide SSO**; Recall is explicit that an existing one must not be reused, because the SSO policy is organisation-wide. |
| 2 | Verified against a Workspace that refuses anonymous joins | Not started |
| 3 | Bot account on the calendar invite, waiting room skipped | Not started |

Until this passes, the honest product claim is "the host admits the bot", and Workspaces that block
anonymous participants are **not supported** — stated, not discovered by the customer.

## Operations gate

| Item | State |
|---|---|
| Missed webhook → reconcile → correct state | **PASS (automated)** — a dropped delivery leaves the record stale; reconcile puts it right and records `reconcile:<status>`; a reconcile that would move it backwards is refused. Still worth repeating once in a live call. |
| Empty account visible to operations | **PASS** — `/health` → `meeting.creditRefusedAt`. |
| Auto top-up configured | Operator action (dashboard setting; not an API) |
| `ATTENDEE_WEBHOOK_SECRET` set | Operator action. The signing secret is **project-level and dashboard-only** — Attendee generates it server-side (`WebhookSecret`, Fernet-encrypted) and no API returns it. Copy it from `app.attendee.dev/projects/<project>/webhooks/` → **Copy Secret**. Until it is set, deliveries are recorded as unverified rather than silently trusted. |
| Bot admitted within 15 minutes | Operational limit, not a bug: the bot-page token's TTL is 15 min (`TOKEN_TTL_MS.bot_page`). A bot left in the waiting room longer than that joins without its avatar page — and waiting-room time is billed. |

## Meeting providers

The connector boundary exists so the meeting vendor is a decision, not an architecture. Two are
implemented; which one is better is a measurement.

| | Recall | Attendee |
|---|---|---|
| Character's voice out | Output Media (a web page as the camera) | the same socket the audio arrives on |
| Avatar (Live2D needs WebGL) | `web_gpu` only, **$1.50/h** | **works** — the webpage streamer rendered Live2D on the Meet tile in the first live run, at the base rate. |
| Base rate | $0.50/h | $0.50/h after 5 free hours |
| Audio rate | 24 kHz out of the box | 8/16/**24** kHz — 24 matches our TTS, no resampling |
| Verified here | join, avatar, transcripts, lifecycle, 30-min soaks | create-bot and the audio contract (unit-tested); **never run against a live meeting** |

What is verified for Attendee comes from the API docs and the vendor's own example:
`POST https://app.attendee.dev/api/v1/bots`, `Authorization: Token <key>`,
`websocket_settings.audio { url, sample_rate }`, `realtime_audio.mixed` in and
`realtime_audio.bot_output` out. What is **not** verified is `voice_agent_settings` — the field that
renders the Live2D page as the bot's camera. It is sent whenever `RECALL_BOT_PAGE_URL` is configured
(and `ATTENDEE_VOICE_AGENT` is not `off`), always with `reserve_resources: true`, which is the switch
Attendee actually reads. The avatar claim stays unproven until a real call.

The saving is real: the avatar at the plain rate, ~$50 instead of ~$150 per 100 hours. Live2D rendered
on Attendee's streamer in the first live run, so the GPU surcharge Recall charges for `web_gpu` buys
nothing Attendee does not already do. Attendee's free 5 hours cover the 10-minute smoke and the
30-minute gate roughly seven times over.

## Perception (added 2026-09-02)

The character reads the room as well as hearing it: Attendee's per-participant webcam at 360p/2 fps →
MediaPipe Face Landmarker in the bot page → cues (nod, head shake, tilt, smile, gaze) → the
participation policy and, optionally, the conversational model.

| Claim | State |
|---|---|
| The face model runs in a browser | **Measured** — 117 ms to load, 13 ms median frame under software rendering, against a 500 ms budget at 2 fps. |
| It reads a real face | **Measured** — 52 blendshapes and a 4×4 transformation matrix from a frame cut out of a real meeting recording. |
| It needs WebGL | **Measured** — both the GPU and the CPU delegate fail without a context. Same requirement as Live2D, which did render inside Attendee, so the two stand or fall together. |
| It runs inside Attendee | **Not verified.** No live run has carried a webcam frame yet. |
| Acoustic turn-end costs no latency | **Measured** — first-audio 221–344 ms with the model off, 235–322 ms with it on, same harness. |

## The meeting path, without a meeting (2026-09-02)

`pnpm reality:attendee:sim` runs the whole path against a stand-in that speaks Attendee's REST API and
its three websockets, and launches the bot page the way Attendee launches it. Everything between the
broker and the character is production code; what is simulated is the vendor.

It found five defects in one afternoon, all of them invisible from outside and none of them reachable
without a meeting until now:

| # | Defect | Why nothing said so |
|---|---|---|
| 1 | **Deadlock on any vendor without its own transcripts.** Audio was gated on "have we been addressed", and on Attendee the only recogniser is the AI's — so no audio, no transcript, never addressed, no audio. | Every counter looked healthy. The character sat in the meeting thinking. |
| 2 | **The outbound converter ignored the frame's sample rate**, assuming 48 kHz. Attendee sends 16 kHz, so one sample in three became the whole signal. | No error. The recogniser received confident nonsense, at a third of real time. |
| 3 | **An explicit engine choice was silently served by another vendor** when a health probe failed. A bot page asking for the local agent was handed a cloud account with no credit. | This is the 429 that killed the first live run. |
| 4 | **The character was pushed into the meeting twice** — once through the page's speaker, which the vendor captures, and again down the socket. | 332 duplicate chunks in one run; in a call it would have been an echo nobody could explain. |
| 5 | **A bot page reports nothing.** No operator, no UI, no logs. | Three separate failures were diagnosed by rebuilding to add a log line. There is now a heartbeat. |

Final state of the run: every row passes, and the character speaks for 9.7 s.

| step | result |
|---|---|
| broker asks for all three sockets | PASS |
| vendor sockets accepted | PASS (mixed, per-participant audio, per-participant video) |
| voice agent page launched and reached the call | PASS (38 s to ready) |
| page ran without errors | PASS |
| **character spoke** | **PASS — 244 buffers, 9.7 s** |
| did not also push it back down the socket | PASS |
| relay carried the streams | PASS (450 messages, 0 malformed) |
| transcripts, engagement | 5 utterances, ENGAGED → COOLDOWN → ENGAGED |

The harness scores behaviour, not only connectivity, and the same run passes across the combinations
that matter:

| run | spoke | transcripts | engagement | camera | to the model |
|---|---|---|---|---|---|
| local · addressed_only · cues | 9.8 s | 5 | ENGAGED → COOLDOWN | 157 cues, 81 with a face | 0 (correct) |
| local · open · **vision to the model** | 10.8 s | 5 | ENGAGED → COOLDOWN | 146 cues, 79 faces | 60 frames |
| **Gemini** · addressed_only · cues | 20.3 s | 5 | ENGAGED → COOLDOWN | 158 cues, 82 faces | 0 (correct) |
| local · **Zoom URL** · no camera | 10.6 s | 5 | ENGAGED → COOLDOWN | — | — |

Camera frames are real: cut from the recording of the 2026-09-02 meeting.

What this still does not prove: Attendee's own browser and its ALSA capture, its scheduling, a real
meeting's audio, and a second human. It proves everything downstream of them, which is where every
failure so far has actually been.

## Which engine (measured 2026-09-02)

Same 2–3 minute harness, same voice (Zephyr) for both Gemini rows, same room audio.

| engine | answered | turn latency p50 / p95 | reply length p50 | notes |
|---|---|---|---|---|
| **Gemini 3.1 flash-live** | 95–100 % | **1162–1222 / 1314–1586 ms** | 25–32 chars | fastest cloud path; no affective dialog or proactive audio |
| Gemini 2.5 native-audio | 100 % | **3871–5646 / 6124–11318 ms** | 13–14 chars | the only family with affective dialog and proactive audio, and 3–5× slower with shorter answers |
| Local: sherpa + gemini-3.1-flash-lite + Supertonic F1 int8 | — | first audio 1195–1658 ms | 30–40 chars | the recogniser that can actually read a meeting room |

The cloud rows are measured on the app's own screen, close-mic. **On the meeting path Gemini barely
speaks at all** — 0.7 s in 80 seconds — because addressing depends on its own input transcription,
and on the same recording where the local recogniser reads 「ゆイ、今 どう 思う？」 it returns 「 。」.

So: 3.1 flash-live for the app, local for meetings, and 2.5 native-audio only when reacting to *how*
something was said is worth three seconds of waiting for it.

## Whether the character can hold a conversation (measured 2026-09-02)

The meeting path proves the character is heard. `pnpm reality:conversation` asks whether it is worth
listening to: a 20-turn text-driven evening chat against the running agent (`scripts/reality/scenarios/friend-evening.json`
— a project at work, a weekend in Kyoto, a dog, a 1on1), each reply waited for until its speech ends,
scored for length, questions asked, backchannel-only replies, mid-conversation greetings, and nine
keyword checks that need the character to have *listened* — 「私が週末どこに行ったか覚えてる？」 ten
turns after Kyoto was mentioned. Reports land in `docs/reports/conversation/`.

The first run found the defect: the model was handed the last 12 messages and nothing else, so after
six exchanges the character had no evening. 「ごめん！どこ行ったんだっけ？」 is a scripted friend,
not a friend.

`ConversationMemory` (`services/agent/src/memory.ts`) replaces the slice. Recent turns stay verbatim
up to a character budget (2400 for the 4k-context local model, 12000 for a cloud endpoint,
`LOCAL_LLM_HISTORY_CHARS`); what scrolls out is folded in the background into a running note —
「【これまでの会話で分かっていること】」 — appended to the one system message, with a line telling the
character these are its own memories and not a script. The fold uses the session's own LLM adapter, so
`strict_local` still transmits nothing. Two things measured on the way there and kept out of the
product: notes as a *second* system message changed the character (five-sentence replies, 「君」, an
invented 「あの写真を見せてもらった時」, 8 of 20 replies timing out) — one system message, notes last;
and a window that slides every turn defeats llama.cpp's prefix cache (first token 130 ms → 1.2 s on
every turn), so the window is cut to half its budget at once and pays one cold prompt per half-window.

| configuration | memory checks | reply p50 | questions | first audio p50 | timeouts |
|---|---|---|---|---|---|
| before — last 12 messages, cloud | **6 / 9** (Kyoto, the app renewal and the project all gone) | 40 chars · 3 sentences | 85 % | 403 ms | 0 |
| after — cloud, 12000-char window (all verbatim) | **8 / 9** | 41 · 3 | 75 % | 402 ms | 0 |
| after — cloud, window forced to 600 to exercise the fold | **8 / 9** (recalled from notes) | 34 · 2 | 80 % | 402 ms | 0 |
| after — **fully local** gemma-4-E2B, 600-char window | **8 / 9** (「ごめん、ちょっと忘れてたかも。…京都旅行だったかな？」) | 36 · 2 | 65 % | 763 ms | 0 |

The one that still failed, in every configuration, was `recalls_project`: asked for advice at turn 9
the character gave good generic advice without naming the project — 「それは人それぞれだよね。まずは話を
聞いてみるのがいいんじゃないかな」. Not a memory miss (the same run recalls the app renewal by name at
turn 18) but a persona one: 「アドバイスの押し付けをしない」 read as 「一般論で返す」. One line added
to `personas/free_talk/friend_ja.json` — 意見を聞かれたら一般論ではなく、相手がさっき話した具体的なこと（誰と、
どこで、何を）に引きつけて答える — and the same harness on the same cloud agent went 8/9 → **9/9** in two
runs out of two (「せっかくリーダーなんだし、誰か一人でも話しやすい人はいないの？」). The cost is length:
reply p50 32 → 44 and 55 characters across the two runs, 3 sentences against the persona's
`maxSentences: 2`. Still a friend's turn, not a paragraph; watched, not tuned further. Reply length
had needed no change before that: the 28-character p50 seen earlier came from the disjointed soak
recording and its barge-ins, not from the persona.

On the local model the fold costs what it costs — 3.5–5.9 s of background generation, and the next
turn's prompt is partly cold (0.9–1.3 s to first token, twice in twenty turns). I first put that down
to the fold evicting the conversation's slot; the server log says otherwise. llama-server picks
`-np` automatically (4 slots here), the fold lands on a different slot by LRU, and the conversation's
slot keeps the persona prefix: the turn after a fold re-processed 212 of 803 tokens — the notes and
the window behind them, which is exactly what changed. That cost belongs to the notes being in the
system message, and a second slot would not remove it. No `-np` change.

## The derived modes, on the same base (measured 2026-09-02)

The order was set by the product owner: a rich ordinary conversation first, and English practice,
interview practice and task organisation derived from it. With the memory in place, each mode got its
own scenario for `pnpm reality:conversation` (`PERSONA=… SCENARIO=scripts/reality/scenarios/…`) and was
run on the hybrid path (local recogniser and voice, gemini-3.1-flash-lite) and again fully local
(gemma-4-E2B, llama.cpp). The harness gained `PARAMS`, per-line `all` / `none` / `maxQuestions` / `lang`
checks, a question count that understands 「〜でしょうか。」 and 「教えてください」, and an "echo
opening" count — replies that hand the answer back (「〜なのですね。」) before saying anything.

| mode | scenario | hybrid | fully local | what was fixed on the way |
|---|---|---|---|---|
| 英会話 `english_daily` | 14 turns, learner slips into Japanese once, asks for 「乗り換え」, memory callback | **13 / 14** (one reply asked two questions) · reply p50 104 chars · first audio 403 ms | **14 / 14** · first audio 406 / 1498 ms | **The voice was told every sentence was Japanese.** Supertonic is tagged per utterance and the session never passed its language, so English came out through the Japanese path — the recogniser heard "Are you need to be a bit successful" for "a morning meeting can be a bit stressful". The session now passes its language to the voice (`en` → 10.6 → 12.1 chars/s, and heard correctly), and the pre-rendered fillers are "Um," / "Hmm," / "Well," in an English lesson instead of 「えーっと」. |
| 面接練習 `interviewer_ja` | 13 turns: vague answer, hesitation, incident, reverse question | **18 / 18** · echo openings **7/12 → 0/13** · timeouts 1 → 0 · reply p50 58 → 44 | **18 / 18** · echo 2/13 · first audio 668 / 1036 ms | The interviewer paraphrased every answer back before asking (「チーム内での調整も重要な役割だったのですね。」 ×7), against the persona's own rule, and on the reverse question it answered at length *and* closed the interview in one breath (25 s, timed out). The persona now says what "do not summarise" means — 「なるほど」 and on to the next question — and how to take a reverse question: two sentences, then 「他にご質問はありますか」, no closing until the candidate says 以上です. |
| タスク整理 `task_organizer_ja` | 14 turns: five tasks dumped in passing, one cancelled mid-way, priorities, first step, final read-back | **14 / 14** · reads the list only when asked, drops the cancelled dentist, ends on 「まずはメールからだね」 | **12 / 14** — the 2B model's final read-back lost the vet and the gym, and it recites the list unasked | New mode `task_planning` and persona: a friend who keeps the list, not a manager. The memory notes are what make the read-back possible after the window has moved on. |

Local-model quality, honestly: the English run passed every keyword and still said "I don't have any
information about your specific meetings" before recalling the meeting; the interview asked its
questions as requests (「教えてください」) rather than questions, which is fine for an interviewer and
was miscounted until the harness learned it. The 2B model holds these modes; it does not hold them
as well as the cloud model, and the read-back of a five-item list is where it shows.

## In a meeting, on the gate's own script (measured 2026-09-03)

The real-meeting gate scores whether the character answers; it cannot say whether the answer was worth
hearing, and its runs are scarce (each needs a person in the Meet to admit the bots). So the meeting
turn was made measurable offline. The text the character is given in a meeting — the session
instructions, the per-turn prompt with the room's recent lines, the greeting — moved out of
`apps/web/src/session/MeetingSessionController.ts` into `@rcai/meeting-core` (`meetingPrompt.ts`),
and `pnpm reality:conversation` learned `meeting` scenarios: each line is the room addressing the
character (`ask`) with the lines before it (`context`), rendered through the same functions the
session uses, so what is measured is what ships. Two scenarios: `meeting-standup.json` (a schedule
question, a data doubt, a release-date change to summarise, an opinion asked, a memory callback, a
hand-off) and `meeting-gate.json` — the attendee-auto cue script itself, in text, with the
recogniser's spelling of the name (「ゆイ」).

| meeting instructions | standup 13 checks | gate script 8 checks | what the replies were |
|---|---|---|---|
| as shipped in Run 28 | **11 / 13** | — | 「本日は午前中に進捗確認のミーティングがあり、午後は資料の作成を進める予定です。」 — a schedule the character does not have, in a register the persona does not use |
| + honesty and substance (one paragraph) | **12 / 13 → 13 / 13** over three runs | 7, 6, 8 / 8 | 「ごめん、今日の予定は手元にないから分からないな。みんなは何の予定が入ってるの？」; 「不具合の修正に一週間かかるから、リリース日を十日から十七日にずらすってことだよね。」 — but 「ゆい、これはどう思う？」 drew 「それ、すごく気になるところだよね。どうしてそう思ったのか教えてくれる？」, a reply with no subject |
| + 「これ」「それ」 rule, appended to the paragraph | — | 7, 7, 6 / 8 | the demonstrative was resolved (「さっき話に出ていた三ページ目の数字のことかな？」) and the invented schedule **came back** in two runs of three |
| the same rules, one per line | **13 / 13, 13 / 13** | **8 / 8 ×3** (and 7 / 8 once, on a check since loosened: yielding to the cut-in is a fair answer to 「今どう思う？」) | 「予定は手元にないよ。そっちは今日、何か予定あるの？」; 「三ページ目の数字のこと？私はそのまま進めてもいいと思うけど、どうしたい？」; 「リリース日は十七日に変更になったよ。」 |

Reports: `docs/reports/conversation/friend_ja-2026-09-03T09-26-*.json` (before), `…T09-3*.json` (after).
The lesson on the way is about the prompt, not the model: rules added to the end of a paragraph cost the
rules before them. Written as a list with one worked example (「今日の予定は？」→「予定は手元にないよ」)
the model kept all of them in four runs of four. The example is also why the first reply now reads the
same each time; a fair price for a character that stops inventing its day.

**A meeting now has its own persona.** The bot page had been falling back to the friend (「友達（雑談）」),
whose job is to draw the other person out — so every answer in a meeting ended in a question
(「そっちは何か予定あるの？」; 3 of 3 turns on the gate script, 6 of 6 on the standup). `meeting_colleague_ja`
(`personas/meeting/colleague_ja.json`, the meeting default via `MEETING_PERSONA_ID` in `@rcai/meeting-core`)
is the colleague who has been listening: answers what was asked, conclusion then reason, a question only
when something needed is missing. Same scenarios, same checks: standup **13 / 13 ×4**, gate script
**8 / 8 ×4**, questions asked 1 of 6 turns instead of 6 of 6 — 「元データを取り直したほうがいいと思います。数字の
正確性を確認しておいたほうが後々安心だからです。」, 「QAで見つかった不具合への対応のため、リリース日を十日から十七日に
延期し、営業への連絡はTesterさんが担当することに決まりました。」. Two things the runs caught on the way: the
worked example's wording (「予定は手元にないよ」) was being repeated in its casual register by the polite
persona, so the example now says *what* to say and leaves the register to the persona; and addressed by
"Tester" the model once said 「〇〇さんは何か確認しておきたいことでもあった？」 — a placeholder out loud —
so the rules now say names are used as written in the transcript or not at all.
Reports: `docs/reports/conversation/meeting_colleague_ja-2026-09-03T09-4*.json`.
One more, after the register was left to the persona: the colleague opened in タメ口 (「ごめんね、今日の予定は
手元にないんだ」 — the Tester speaks casually and the persona allowed 「少しくだけてよい」) and switched to
です・ます from the second turn on. The persona now keeps one register for the whole meeting (soften the
endings, never switch to 「〜んだ」「〜だよ」): 「すみません、今日の予定は手元にないですね。Testerさんは今日、
何か予定が入っていますか？」, and the same register through the summary and the hand-off. Gate script
8 / 8 ×2, standup 13 / 13 (`…T09-59-*.json`, `…T10-00-18.json`).
The arrival greeting — the first thing a real room hears — is measured on the same script now
(`{ "greeting": true }` renders `meetingGreetingPrompt`): 「こんにちは、Yuiです。Yuiと声をかけてもらえればお返事
しますので、よろしくお願いします。」 — name, how to get its attention, no question, no speech. Gate script
12 / 12 ×2.
`pnpm reality:address` — the ParticipationPolicy fed a room's lines, its decisions run through the real
agent — used to carry its own one-line prompt and send the bare question; it now sends the meeting persona,
the meeting instructions and the turn prompt with the room's lines, the way the bot page does. First thing
it showed: asked 「来週までにやることを教えてください」 with nothing decided, the character produced a plan
(「先週の数字データの集計とレポートの作成を予定しています。水曜日までに終わらせるつもりです」). The honesty rule
named 予定・数字・出来事; it now names 担当タスク and 締め切り too, and a standup turn asks the same question:
「来週までのタスクはまだ決まっていないので、手元にありません。何か割り当てられた作業があれば教えていただけますか？」
(address gate 2 / 2 honest after the change, standup 15 / 15 and 16 / 16, gate script 15 / 15 with the
greeting and a names-as-written check — a katakana reading of a name is allowed, 「テスト担当者さん」 and
「〇〇さん」 are not).

**The answer is now bounded in time as well.** The same afternoon's agent log, 89 turns against
gemini-3.5-flash-lite: first token p50 0.83 s, p90 1.3 s — and 8 turns above 3 s, the worst 13.1 and
17.3 s. Seventeen seconds of silence after a question is, in a meeting, no answer (the gate closes its
window at 15 s). The slow starts are per request, not per model, so `HedgedLLM`
(`services/agent/src/adapters/llm.ts`) sends the same request again when the first has produced no
token after 2.5 s (`LOCAL_LLM_HEDGE_MS`; off on loopback, where llama.cpp would only queue it) and
speaks whichever stream answers first, aborting the other; a request that fails outright is retried
the same way. Seven unit tests cover the race (prompt first request untouched, late one overtaken,
first one still winning after the hedge, failure retried, both failing, fallback adapter, caller
abort reaching both). Over the 48 turns measured since: p50 0.96 s, three hedges, worst first token
4.3 s. Whether the second request wins often enough on a bad afternoon is not yet known — in all three
hedges so far the first request came through before the second had connected.

Two evenings later the bad afternoon arrived. Over ~290 turns of soak the first token sat at 0.67–1.32 s
except for the stalls, which sat at 2.4 s and beyond — nothing in between — and in Gate #8 runs 46 and
47 the greeting's *two* requests both stalled (30.6 s and 22.8 s to the first token: the hedge fired at
2.5 s and was as silent as the original). So the hedge is now a ladder: it fires at 1.8 s (the wait
between 1.3 and 2.5 s bought nothing and was heard in the room as a hole after 「えーっと、」), and a
second request that is also silent for `afterMs` is followed by a third (`maxRequests`, default 3).
Nine unit tests now, the new ones for the third step and the cap.

## Known unverified — the next things likely to break

Two live runs, two bugs that only a live run could show (a sample rate, and a flag
whose absence produced no error). These are the ones I can name but have not yet
proved either way. None is theoretical; each has a specific failure mode.

| # | Risk | Why it is plausible | How it will be settled |
|---|---|---|---|
| 1 | ~~AudioContext suspended inside Attendee's browser~~ | **Answered from the vendor's source.** `bots/webpage_streamer/webpage_streamer.py` launches Chrome with `--autoplay-policy=no-user-gesture-required` and captures the page's own output (`alsasrc device=default`, S16LE mono 16 kHz) into the meeting. Audio needs no gesture there. Still to be seen once in a live recording. |
| 2 | ~~No WebGL in Attendee's page browser~~ | **Settled by the live run, against my prediction.** I read `--disable-gpu` with no `--enable-unsafe-swiftshader` in their launcher, reproduced `webgl2:false, webgl1:false` under those exact flags in local macOS Chrome, and called Attendee voice-only. Then the first live run put the Live2D character on the Meet tile. The flags are not the whole story — their Linux image evidently supplies a GL path mine does not — and a local reproduction of someone else's container is a hypothesis, not a measurement of it. **Attendee renders the avatar.** The `webglAvailable` guard stays: it turns a blank tile into a named error wherever WebGL really is absent, and it correctly did not fire here. |
| 3 | ~~No Attendee webhooks~~ | **Done.** `bot.state_change` is subscribed at create time and drives the record monotonically, signature verified against Attendee's canonical JSON (`X-Webhook-Signature`). Without `ATTENDEE_WEBHOOK_SECRET` a delivery is recorded as unverified rather than silently trusted. |
| 4 | ~~Join notice unsent on Attendee~~ | **Done.** The first `joined_*` state triggers `send_chat_message` once per bot. |
| 5 | ~~Attendee meetings absent from the record~~ | **Done.** The route creates an intent and the webhook advances it, so an Attendee meeting has the same lifecycle and screens as a Recall one. |

Fixed after the second live run: the harness called a leave route that did not exist,
so a bot in a meeting that stayed open would have kept running and billing. A 404 on
cleanup looks exactly like success when nobody checks.

## The model's quota, because a free key is not a product (measured 2026-09-04)

Three soaks of the Meet configuration (sherpa + Supertonic + a cloud model over the OpenAI-compatible
endpoint, `PRIVACY=default`, 10 / 10 / 3 minutes, the harness's own Japanese utterances every ~8 s)
against the project's free-tier Gemini key:

| soak | model | what happened | agent-side numbers |
|---|---|---|---|
| 19 · 10 min | gemini-3.5-flash-lite | `429 … free_tier_requests, limit: 15` (a minute) at 113 s; three turns were 「えーっと、」 and then nothing (`reply "" (no audio)`) — the exact 「Yuiからの応答がありません」 | first token p50 901 / p95 1310 ms; ladder answered first ×7, second ×6, third ×2; 39 「no first token」 hedges |
| 20 · 10 min | gemini-3.5-flash-lite | `429 … GenerateRequestsPerDayPerProjectPerModel-FreeTier, quotaValue 500` from 17 s: **the day's 500 requests were gone** (two soaks plus the day's Meet runs, each turn up to three requests) | quota hold held the ladder to one request; 13 recovery lines spoken, no silent turns |
| 21 · 3 min | gemini-3.5-flash | works — then `limit: 20` a day at 113 s | first token p50 970 / p90 1103 / max 1274 ms over 16 turns, **no hedge fired**; 1 recovery line |

Two things follow.

1. **`BLOCKED_BY_GEMINI_FREE_TIER` for the hybrid engine.** The free key allows 15 requests a minute and
   500 a day on flash-lite, 20 a day on flash, and the three-step hedge spends up to three per turn.
   That is ~160 turns a day — one evening of Gate #8 runs, not a product. A billed key (or the local
   model) is a release prerequisite for the hybrid engine; the ladder's per-turn cost is the price of
   the 1.8 s first-token guarantee and should be paid for, not worked around.
2. The agent now treats a quota error as what it is (2491a15): no retry inside the window, the ladder
   held to one request for as long as the error asks, and a spoken recovery line — 「ごめん、いま考えが
   まとまらなかった。もう一回言ってもらえる？」 — instead of the filler left hanging. Soak 20 is the
   evidence: the same exhaustion that produced silence in soak 19 produced an owned miss.

Until 16:00 JST (the Pacific-midnight reset) the agent runs on the local model (gemma-4-E2B via
llama.cpp, `hedgeMs 0`); the OpenAI key on file has no credit (`You have no credits remaining`).
Soak 20 also showed what a minute-long hold sounds like: the same apology thirteen times, asking
the person to repeat themselves when repeating could not help. `cb0b656` turns the line into a
ladder — ask for a repeat once, then say it needs a moment, then own that it is off today and stay
on that line until an answer resets it (agent tests 106 / 106; not yet heard in a meeting).
Soak 22 (2 min, `strict_local`, same utterances) is that configuration's evidence: 13 / 13 answered,
first token p50 149 / p90 186 ms, turn p50 649 / p95 1704 ms on the HUD, no errors, no toasts, replies
of 13–48 chars (「面接で緊張するのってよくあることだよ。何かリラックスできるルーティンとかある？」).

## The gate's script, through the bot page, without a meeting (measured 2026-09-04)

While the room stayed unadmitted (runs 48–62, `BLOCKED_BY_NO_ADMITTER`) the cue script itself was
put through the real bot page on the local engine: `scripts/reality/attendee-sim.mjs` now sends
`outbound=page` like the live harness, and `gate-script-16k.wav` (270 s, the seven cues spoken in
order) was played into it as the room. Sims 24 and 25 (gemma-4-E2B via llama.cpp, supertonic-3):
every step and behaviour row PASS — greeting; `ask1` answered as a vocative; the un-addressed
「third」 line ignored; the barge-in cut the reply mid-sentence and the follow-up was answered as an
engaged turn (as in run 47); `ask2` answered; `PASSIVE → ENGAGED → COOLDOWN`; six separate
stretches of speech, 16.5 s of audio; no name parroted. First token 230–483 ms on every turn but
one: the **greeting waited 5136 ms**, because the 988-token system prompt had never been read into
the model (cold 3430 ms, ~110 ms once cached — llama.cpp's cache is a prefix cache). `48e9bec`
sends a one-token request at session start and whenever the meeting prompt changes, so the prompt
is cached before anyone speaks; sim 26 on a freshly restarted llama-server: `llm warm 1554ms` while
nobody waited, greeting first token 148 ms. Remote endpoints are never warmed (nothing to cache,
quota to spend); a failed warm-up is logged and ignored (agent tests 108 / 108).

The greeting the local model gave was 「初めまして、Yuiです。」 — the half the room needs, that
saying its name gets an answer, dropped 4 times out of 4 when the instruction was one sentence
with a clause in it. Numbered as two required points (`a47a760`) it kept the clause 5 / 5 against the
full meeting system prompt; sim 28, a silent room: 「こんにちは、Yuiです。Yuiと声をかけていただければ
返事をする…」, 6.4 s of audio, first sound 4.7 s after the bot was created. TTS on this engine is the
floor now: about a second per phrase, streamed phrase by phrase. The agent had been started on the
float weights and was moved to int8 (the run 46–47 environment) on the strength of the earlier
"halves synthesis" measurement — which was for a 3.4 s utterance. At the lengths a meeting reply
actually opens with it buys nothing: first phrase requested → first PCM (`ttsTtfaMs`), 6 characters,
float 271–300 ms against int8 335–464 ms; ~20 characters, float 551–672 against int8 618–1484 ms
(int8 sampled 42 turns, float 7, both with llama.cpp finishing the reply on the same machine).
The `req→done` figures that first suggested a gain include the paced playback (600 ms lead) and
say more about the audio's length than the synthesis. Runs 63 onward stay on int8 for parity
with the last admitted runs, not for speed; whether the smaller weights sound worse is unheard. Sim 32, the whole script on that final configuration (int8, warm
prompt, numbered greeting): every row PASS, eight stretches of speech, 23.1 s of audio, `ask1`'s
first sound 1.7 s after the text turn (first phrase 271 ms, its synthesis 1405 ms — llama.cpp was
still finishing the reply on the same machine), the barge-in cut generation 3 and the follow-up
was answered (「はい、大丈夫ですよ。」).

The conversation gate, which had only ever scored the hosted model, was then run on this one:
meeting-standup **16 / 16** (the release-date callback 「十七日に変更になる見込みです」, the summary
with date, cause and owner, the hand-off to 田中さん), meeting-gate 14 / 15 — the miss was
「ゆい、これはどう思う？」 answered as 「その件については…」, the rule about an ambiguous 「これ」
being one the 2B model drops from the system prompt. Restated on the turn that carries a bare
demonstrative and only then (`bca64b1`), it grounded or asked which 6 / 6 in a direct probe and
named the topic before answering when the referent was clear; through the agent, 4 of 5 runs,
the last three **15 / 15** in a row, two of them 「三ページ目の数字のことでしょうか？その部分については、
修正されるのは良いことだと思います。」 — the room's own material, named and answered (the miss asked
「昨日私が言っていたことについてでしょうか？」, a which-question the checker now counts). Replies run 40–70 characters and 4–14 s of speech on this engine — the summary turn is
three sentences where the persona asks for two.

Sim 33 then showed where the 1.7–2.3 s to first sound went: not the model (first token 258 ms)
but the chunker — a reply opening 「昨日、」 had its first comma refused as too short to speak,
and `firstClauseBoundary` never looked past the first comma, so the reply waited for the 60-char
break: 43 characters synthesised before anything was heard. `219101e` searches from the minimum
and drops the 24-char cap (the longer clause is always the earlier one). Sim 34, same script:
every row PASS and first sound **797–860 ms** after the text turn on all three answered turns
(first token 220–263 ms, first phrase 278–332 ms, synthesis 465–582 ms).

One thing the local model does that the hosted one did not, left as it is: it repeats the
recogniser's garble. SenseVoice wrote 「三ページ目の数字」 as 「3定リ目の数字」, and asked about
it the model said 「定リ目の数字のことでしょうか？」 (or 「定例目」「定指目」 — 7 of 8 in a direct probe,
all grounded, all garbled). A rule saying not to repeat a word that makes no sense did not transfer:
generic wording left 8 / 8 garbled, an unrelated worked example (「しめ霧まで」→「締め切りまで」)
7 / 8; only a rule quoting the scenario's own garble brought it to 1 / 8, which is teaching to the
test and was not kept. The fix is a recogniser that hears 「三ページ目」, or the hosted model. The recogniser on hand
(`LOCAL_STT_FINAL=whisper`, large-v3-turbo as a second pass over each finished utterance, sim 35)
hears 「3ページ目の数理」 — closer, still not the word — and spells the name 「ゆい」 as the room
does, at 1.1–1.2 s per utterance on the turn path (5.0 s for its first, 3.0 s once), which every
cue would pay before the page even learns it was addressed. All rows still PASS at that cost;
first sound 0.8–1.1 s after the text turn. Not taken for the next runs: a partial fix for the
words is not worth a second on every turn while the gate is about answering at all.
Re-run without it on the agent process the next runs will use (sim 37): 14/14, the same five
turns as sim 34, first sound 723 / 843 / 819 / 1001 ms after each text turn.

Taken instead, off the turn path: `LOCAL_STT_FINAL=whisper-async`. The streaming text still goes
out at once and the page decides on it; the second pass runs afterwards and, when it read something
different, sends a revision of the same utterance (`user_transcript_revised`, by utterance id), which
replaces the line in the context handed to the model on later turns — never a turn of its own. Along
the way, a bug in that context: the line spoken right before the address was dropped, because the
answer was composed inside the transition before the line was appended (sim 38 with the fix: the
last reply is grounded on 「あそこは後で直しておくね」). Three things the sims then found:

- **The second recogniser was not deterministic.** Sim 39: the four cue utterances came back as
  "and then", "oh", "and go" while the ordinary lines were fine, and the same 2 s wav gave
  「ゆい、今どう思う?」, 「ゆい、どう?」 or "and go" on repeated calls. whisper-server keeps one decoder
  state across requests, and by default the previous request's text is the prompt for the next —
  so each utterance was decoded in the light of whatever came before it. `no_context=true` on every
  request (and `-nc` in `scripts/local-stack.sh`): 15 / 15 identical over three cues, sim 40 all nine
  utterances right (「見たよ。3ページ目の数理が少し気になったかな。」, 「ゆい、今日の予定を教えて。」).
- **Run beside the model it costs the first sound.** Sim 40: first audio 1364 / 1649 / 1257 ms
  (first token 362–569 ms, against ~250) — the recogniser and the model share the GPU, and the pass
  over the addressing cue started at the same moment as the reply to it.
- So the pass waits for the reply's first audio (or 600 ms, if the page takes no turn on that
  utterance; capped at 4 s). Sim 41: 14/14, first audio **919 / 775 / 749 ms**, first token
  237–310 ms — the cost of the earlier sync pass and of the concurrent one both gone, and the
  context for the last turn reads 「見たよ。3ページ目の数理が…」.

Whisper spells the name 「結衣」 (「結衣が昨日そう言ってたよね」), and that is not cosmetic: asked
「これはどう思う？」 over that context the model answered 「結衣さんが言っていたのは…」 — a colleague,
not itself — 8 times out of 8, and a rule listing the spellings as its own name changed nothing
(8 / 8 again). Rewriting the line to 「Yuiが昨日そう言ってたよね」 before it reaches the model, no
rule: 7 / 8 answered as itself, grounded 8 / 8. So the page now writes every spelling of the name
the way the model knows it (`canonicalizeName`: aliases, kana in either script, latin any case) in
the context and the addressing line. Sim 43: 14/14, first sound 623 / 752 / 811 / 986 ms.
The greeting after an agent restart is still the warm-up race (4.1 s first sound in sims 40 and 41,
first token 3.6 s; a real run's session is warmed while the bot waits in the lobby).

With the room's words finally right, the schedule question: 「今日の予定を教えて」 over that context
drew 「今日の予定は手元にありません。何か確認したいことがあれば教えてください。」 8 times out of 8 —
honest, and empty, in a meeting that had just talked about the numbers on page three. The rule that
says not to stop at not knowing was there; the honesty rule's own example (「予定は手元にないと正直
に言う」) ended where the answers ended. The example now goes on to name one point from the meeting
and not to claim work someone else took on: 8 / 8 mention the room, 0 invent a schedule, 0 make the
colleague's fix their own (a first wording had 1 / 8 say 「私が後で修正する予定です」). The other turns
unchanged (「これはどう思う」 grounded 8 / 8, summary 2.0 / 3 facts). Sim 44: 14/14, the answer in the
room 「今日の予定は手元にありません。ただ、さっき話に出た資料の数理の部分について…」, first sound
591 / 1115 / 818 / 1352 ms (the two slower ones are longer first phrases, 15 and 24 characters
before any pause — synthesis 757 and 891 ms; the second pass had already been held back).

None of this is a meeting: the recogniser heard a wav, not a room, and nobody was there to be
answered. It is the evidence that the path the next admitted run will exercise — ladder, second
filler, recovery lines, warm prompt, greeting — works end to end on the engine that run will use.

## The reply path after run 89, without a meeting (measured 2026-09-05)

Run 89 left the words right and the sound late: turn → audible 5–7 s, `ask2` stretched with 2.6 s
gaps. Between that run and the next knock the agent's own timings were taken apart on the same
engine (offline sims 51–63, `attendee-sim.mjs` with `ask1-16k.wav`, the built bot page on :5180, a
stand-in Attendee on :8799; scratch benches in the session's scratchpad). Five findings, four fixes:

- **The agent the room had been talking to was running the float voice.** `SUPERTONIC_PRECISION` was
  unset on the process behind runs 63–89, so the int8 build the docs credited was never loaded. int8
  is the default now (`config.ts`); the session log carries a UTC stamp on every line so the agent's
  timeline can be laid against the harness's. Sim 51 on the restarted agent: 3 / 3 conversation rows
  PASS, first audio 720 ms after the text turn.
- **Every turn after a `memory folded` paid 1.9–2.4 s for its first token** (0.35–0.45 s otherwise,
  run 89's agent log). The fold rewrites the notes inside the system message and its own request
  takes the single llama slot's cache, so the next turn re-read the whole prompt. The composed prompt
  is now read back into the model right after a successful fold, while the voice is still speaking
  (`session.ts`; agent test *reads the prompt back into the model after a fold*). Sim 52: `llm warm
  171 ms` between turns, first token 200–264 ms on the turn after a fold.
- **The old `tts Nms (req→done)` line measured playback, not synthesis** — it ran to the last *paced*
  frame, so a 3 s phrase always read as ~3 s of "TTS" and sims 52–58 were analysed against it.
  Replaced by two numbers (`to first audio` / `to last frame`) plus a `supertonic Xms [after Yms in
  queue] Nch` line from the adapter itself.
- **Two ONNX Runtimes in one process made the voice 2.2–2.7× slower.** `@huggingface/transformers@4.2.0`
  (the smart-turn detector's feature extractor) pins `onnxruntime-node@1.24.3`; Supertonic runs on
  1.29.0. Merely loading the second dylib slowed every synthesis — 6 ch 117 → 220 ms, 14 ch 170 → 380,
  32 ch 265 → 700 (bisected with MODE=none/turn/hf/ort124/sharp: the import alone does it, `sharp`
  and the detector's session are innocent) — and loading it *after* the Supertonic sessions exist
  aborts the process (`bad_array_new_length`). A pnpm override pins `onnxruntime-node` to 1.29.0 for
  the whole workspace (root `package.json`); the detector still reports `ready` on it. In the agent,
  detector loaded: 6 ch 130 ms · 12 ch 166 · 14 ch 200 · 32 ch 320. Sim 60 under the bot page's
  Chromium: 196–275 ms per phrase, first audio 221 ms after the text turn (sim 53 had 777).
- **Four intra-op threads beat the runtime's ten.** The default pool spans the six efficiency cores
  and each op waits for its slowest thread: alone, 15 ch 195 → 180 ms and 45 ch 410 → 360; with
  twelve busy processes (what a reply faces while the bot's browser renders) 780 → 620 and
  1640 → 1440. `SUPERTONIC_THREADS=4` by default (`config.ts`, the vendor helper patched to take
  session options in `scripts/fetch-supertonic.sh`); whisper and llama running at the same time
  barely move the voice.

And one conversation defect the sims caught twice (52, 60) that no room run had named: 「ゆい、今日の
予定を教えて」 ended 0.4 s before the room went quiet enough for the greeting, and its final transcript
landed while the greeting was being spoken. Nothing had cut the greeting (the speech was over), and in
RESPONDING the policy only counted the line — the question was never answered (`entered a conversation
FAIL PASSIVE`). An addressed final transcript that lands mid-reply is now held and taken as the next
turn the moment the reply ends; a reply that is cut off drops it (whoever cut in brings their own
transcript) (`ParticipationPolicy.heldAddress`, 2 policy tests + 1 controller test through `answer()`).
Sims 61–63 with the fix all PASS on the barge-in path — the race is timing-dependent and did not
recur in three tries, so the room-side evidence is the unit tests and the next admitted run.

Measured, not yet heard in a room: the int8 voice, the single runtime, the thread cap and the held
turn have run only in sims. `pnpm gate` 64 files / 640 tests after all of it. Still open from run 89:
the 2.2 s from utterance end to turn (vendor transport + endpoint), `ask2`'s gaps under load, the
muffled f99, 「数字」 → 「数理」, the two missing `spoke` reports, run 88's inaudible stretch.

### Heard in a room: run 90 (2026-09-05, 17:56–18:17 JST)

All of the above ran in run 90 (row 90): 7 / 8 then 7 / 7 ×3, greeting text → first audio 450 ms,
first token 351–460 ms on a warm prompt, first phrase → first audio 259–716 ms. The held turn did not
fire (no `(held while speaking)` in four passes — the race is timing-dependent; the tests remain its
evidence). What the room added:

- **The half-window costs two cold prompts, not one.** The llama log shows it every pass: the halving
  cut at compose re-read 763–806 tokens (first token 1.3–1.6 s) and, a turn later, the fold's notes
  re-read 1008–1283 tokens (2.3–2.5 s); the fold's own 6–8 s request went to another slot and the
  re-warm (1.4–1.9 s) did not always land before the next turn. Fixed: the cut is now *staged* in
  `ConversationMemory` and lands together with the fold, so the prompt changes once, read back while
  the voice speaks; past 1.5 budgets it still cuts at once, and a `queued` index keeps a compose during
  the fold — or after a failed one — from folding a message twice (memory tests, 78c7e2e).
- **The fold ran alongside the voice.** Pass 3: the fold's 6 s request started the moment the model
  finished writing, Supertonic took 1391 / 1436 ms a phrase instead of 330 ms, and the whisper rescore
  running at the same time took 2.3 s instead of 1.2 s. The fold now starts once every phrase of the
  reply has come back from the voice (synthesis ends seconds before playback — pass 3 would have
  folded and re-read from 33.4 s to 40.8 s with the voice speaking until 43.2 s), and a reply that
  was cut off does not fold at all (a barge-in turn is about to use the model). Session test: the fold
  starts after the last phrase's synthesis and before `assistant_speech_ended` (78c7e2e).
- **In-room Supertonic is 2–4× the sims** (277–999 ms a phrase, one 2.4 s under barge-in load): the
  host runs the Attendee VM at 221–494 % CPU during the passes. A production host does not carry
  the two Chrome bots; `DEGRADED_BY_HOST_CPU` covers it, and the number to hold is the sim's.
- **A rescore can hallucinate on a holey fragment and the hallucination reaches the reply.** Pass 1:
  「めた。」 → 「メタル」, 「ア定ージ目…」 → 「なんてエリメが…」, and 「エリメ」 came back in two
  replies (「エリメの件についてですが、…」). The guard (3cb8700) compares the rescore to the
  incremental text and dropped 「メタリオス」 in pass 2, but 「暫定時目の数理」 passed. Open: a
  fragment cut by an ears hole should not be rescored at all (the hole is in the audio, not the
  recogniser) — the relay knows where the holes are.
- **The admitter's open mic feeds the room back.** At 08:56 Z the agent transcribed Yui's own
  greeting, garbled, through the mic of the person who admitted the bots; pass 1's `bargein` read
  6.3 s of sound after the `interrupted` when Yui had said 0.9 s (「はい、どうぞ。」). The held turn
  must never fire on that echo — it needs a name and a question, which the garble did not carry, but
  this is the case to watch in the next run.
- Vendor transcript FAIL 0 / 0: Attendee's caption transcription finished `failed` on the Tester (run 88
  the same, run 89 passed) — the vendor's transcriber, no bearing on the character. Eight `spoke`
  reports filed as `reply=""` with the audio present: the harness re-read late `spoke` events only at
  the leave; per pass now (e3bbddd).

### Heard in a room: run 92 (2026-09-05, 19:53–20:40 JST)

Run 91 in between was void (row 91: the agent's tunnel had died with a reboot and nothing checked it).
Run 92 ran the staged cut and the deferred fold for four passes — 8 / 8 · 7 / 7 · 6 / 7 · 7 / 7, the one
miss `bargein` PARTIAL by timing (the reply had ended before the cut-in arrived).

- **The staged cut and the deferred fold did what they were built for.** The turn that crossed the
  budget read 196–199 tokens (360–406 ms) where run 90 read 763–806 (1.3–1.6 s); the fold started after
  the reply's last phrase came back from the voice and Supertonic stayed at 180–680 ms a phrase beside
  it (1391 / 1436 ms in run 90); the re-warm landed before the next turn in all three folds (next first
  token 327–364 ms). `spoke after the window` no longer files answers as `reply=""` (e3bbddd).
- **llama-server's context was the real ceiling.** `local-stack.sh` starts it with `-c 4096`, which is one
  unified KV shared by four auto slots. A 2907-token conversation prompt and a 958-token fold did not
  fit together: the server saved the conversation slot to its host prompt cache to make room, the
  barge-in's yield turn arrived, cancelled the fold, failed to load the saved prompt back and re-read
  **3100 tokens in 4.5 s** (pass 3, first token 4.6 s for 「はい。」). Run 90's server had been started by
  hand with a larger context, so the two-miss pattern hid this one. `local-stack.sh` now starts at
  `-c 16384` and warms the server with a short and a ~1000-token completion — the first requests after
  a start had cost 7.8 s for 27 tokens and 9.0 s for the greeting's prompt (Metal pipelines compiling),
  and the greeting waited 7.9 s behind that warm. After the restart: 11 tokens 131 ms, 436 tokens 622 ms.
  Not yet heard in a room.
- **The prompt at the 1.5-budget cap is 3100 tokens.** A fold cancelled by a barge-in leaves the cut
  staged and the window grows until the next fold; with the KV fixed that costs nothing on a hit and
  4.5 s on a miss. Whether to lower the cap (1.25 budgets) is a question for a run on the new context.
- Attendee: the first two knocks expired at Meet's limit (the admitter was away) and park mode
  restarted the worker with 28 leaked Chromium before the third; the third joined in 34 s of being
  admitted. Yui's own `transcription_state` ended `failed` again while the Tester's captions read her
  (21 / 61) — the vendor transcript row depends on which bot's transcriber survives.

Run 93 (row 93) heard the fixes above for two passes and a half — greeting first token 234 ms, the
session's prompt read in 1.6 s, the fold re-warmed in time — before the bot host's Docker VM died on a
host disk at 98 %. The bot host's disk is a pre-flight item now in practice (`df` before the knock);
the harness survives the vendor vanishing (d5eabb9) but cannot make the room hear a character whose
browser has stopped.

### Heard in a room: run 94 (2026-09-05, 23:20–23:43 JST) — every cue PASS, and the last 5 s named

Four passes, 8 / 8 then 7 / 7 ×3, `bargein` ×4, vendor transcript 24 / 62. The one latency left on the
reply path is the turn right after a barge-in in a conversation that has folded once: 5.2 / 4.9 s to the
first token (passes 3–4), and the llama log explains it end to end. The fold is deferred until the reply's
synthesis is done, which places it inside playback — exactly when a barge-in can come. It runs on
another slot; llama-server's default `--clear-idle` then *saves the idle conversation slot to the host
cache and clears its KV* ("save and clear idle slots on new task"). The barge-in cancels the fold, the
yield turn arrives, and its prompt no longer matches the saved one: the cache holds the reply as it was
generated, the history holds what the room heard before the cut. `failed to load prompt from cache` →
the whole 3300-token prompt is read again. Run 92's 4.6 s was this, not the 4096-token KV (which was
real too, and is fixed).

`--no-clear-idle` keeps idle slots resident; with 16384 tokens of unified KV the conversation (≤ 3300),
a fold (≤ 1000) and a re-warm (≤ 3300) fit side by side. Verified directly against the server after the
restart: a 1456-token prompt, a 558-token prompt on another slot, the first prompt again with a tail —
9 tokens re-read in 102 ms and no save/clear in the log. What remains after a cut is the honest
divergence at the interrupted reply (sim 0.82–0.83 in the log, ~600 tokens, ≈ 1 s) — the history says
what was heard, as it must. Not yet heard in a room.

## Cost, because it is a production requirement

Pay-as-you-go is $0.50/bot-hour, and `web_gpu` — which Live2D needs, since no other variant has WebGL —
is $1.50/hour. **Waiting-room time is billed.** Two bots doubles it, which is one more reason the two-bot
run is a transport test and not the gate. This session spent the $5 free grant: 0.92 h at 2-core and
2.97 h on GPU, mostly on debugging.
