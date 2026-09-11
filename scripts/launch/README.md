# Real-session recording helper

Development-only capture of the real `SessionController`, Gemini Live provider,
TaskLedger, SpeakerOutput and local VRM renderer. This is a recording layout, not
a screen recording of the normal application. The Japanese inputs are authored
demonstration examples synthesized with the macOS Kyoko voice; assistant speech,
captions and task mutations come from the actual provider and runtime. Both
disclosures are visible in the video. No Live2D material is used.

```sh
node scripts/launch/record-demo-server.mjs --prepare-voice
```

Open `http://127.0.0.1:5180/` in Chrome and click
**実AIに接続して録画（最大60秒）**. This starts one real Gemini connection through
the existing broker, sends two synthetic voice inputs, attempts to interrupt the
first answer and requests a task update. After a confirmation action it sends a
third short input asking the actual AI to read the current saved state. No microphone or screen capture
permission is needed. Keep the tab visible during recording. The maximum capture
duration is 60 seconds; the session is disposed before encoder finalization.

The server listens only on loopback. It never reads API keys. The broker URL may
be changed with `RCAI_CAPTURE_BROKER`; its CORS configuration must allow the local
origin. The local production broker permits port 5180. A request is made only
after clicking Start and may incur normal provider usage charges.

Outputs go to `/private/tmp/ai-meeting-launch-capture` (override with
`RCAI_CAPTURE_DIR`):

- `1.wav`, `2.wav`, `3.wav` and their original input text files.
- `<recording UUID>.webm`: actual 1280×720 canvas and audio recording.
- `<recording UUID>.json`: timed provider transcript and task events, observed
  assistant audio, and whether interruption occurred during playback.

Review the video and evidence before publishing. Missing responses, task updates,
or an interruption cannot be inferred as successful from a completed recording.
If the real runtime requests confirmation, the scripted recording can confirm a
proposal only when its task titles, statuses and deadlines exactly match the
disclosed synthetic input. The pending proposal and confirmation action are
visible in the recording and saved in the evidence. A mismatched proposal stays
unconfirmed. This uses the actual `resolveTaskProposal` action, not a direct task
state edit.

The helper does not publish, fabricate responses, or send session
evaluation/telemetry. Audio is branched from the existing final output
node for capture; it is never played a second time.

The official `AvatarSample_B` model and its separate pixiv license
come from `apps/web/public-oss/characters/vroid-b/`. Keep its attribution and
license with any redistributed model files.

Type check: `pnpm exec tsc -p scripts/launch/tsconfig.json`.

The default broker is loopback `http://localhost:8787`. Start the configured local broker before recording; the public hosting broker intentionally rejects new paid AI sessions. Set `RCAI_CAPTURE_BROKER` only when using an explicitly configured alternative.
