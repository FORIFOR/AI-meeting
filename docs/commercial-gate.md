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
three local patches in the clone: Chrome log path, no debug screen recording, a seccomp profile Docker's runc
cannot load). Two bots in one Meet room is one Chrome per bot in the worker plus the webpage-streamer's software
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

What the runs settled: the character answers when the question arrives whole (22), and the failures are
the host, not the conversation — under emulation the worker's two Chromes and the streamer take the CPU the
Tester needs to deliver the question in one piece, and what Yui does say comes back stretched or muffled.
So the run that follows (29) starts with the CPU relief already in place (`YUI_PAGE_FPS=15`, 360p streamer,
no debug recording, Tester at 720p, mp3 recording), a hedged LLM (below), and the colleague persona; the
markers are `DEGRADED_BY_HOST_CPU` for a run whose cues fail with the question fragmented, and
`BLOCKED_BY_NO_ADMITTER` for one nobody admitted. If 29 is still degraded the next lever is a native arm64
Attendee image, not another prompt.

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

## Cost, because it is a production requirement

Pay-as-you-go is $0.50/bot-hour, and `web_gpu` — which Live2D needs, since no other variant has WebGL —
is $1.50/hour. **Waiting-room time is billed.** Two bots doubles it, which is one more reason the two-bot
run is a transport test and not the gate. This session spent the $5 free grant: 0.92 h at 2-core and
2.97 h on GPU, mostly on debugging.
