# Conversation benchmark protocol

The representative workflow is `task_planning`: speak a task and an explicit deadline, check the saved result, end the session, reload, then continue from that task in the next session. A success requires the intended task, status and deadline, persistence, and no unconfirmed change. A response containing reassuring words is not proof of a successful save.

## Collect, classify, review

Use a separately configured, budgeted environment for long sessions. The public trial is limited to 180 seconds and 30 shared monthly reservations, including verification attempts; do not reset or raise its quota to satisfy a benchmark.

After a session, open **目視評価と計測 → 計測JSONを保存** on the result screen. Save the original JSON in a private evidence directory, then add one row per attempt to a private manifest initialized as `{"schema":"rcai.conversation-benchmark.v1","sessions":[]}`. The [published manifest](validation-assets/conversation-benchmark-manifest.json) is historical synthetic evidence, not an empty template. The export contains timing observations, counts and a session ID; it contains no transcript, task text or media. Existing human-gate incident exports are separate and may contain captions.

Use `inputSource: human` only for a consenting person speaking live, confirmed by the operator. `synthetic` means authored/synthesized user input with real AI responses; `fixture` means the responder or conversation is simulated. They never contribute to the human count. A browser cannot attest that its microphone stream belongs to a person. Review references are opaque IDs into private participation/consent records, not names or emails. Do not commit raw human records to GitHub.

Example **structure only**, not evidence:

```json
{
  "schema": "rcai.conversation-benchmark.v1",
  "sessions": [{
    "id": "attempt-001",
    "sourceCommit": "<full 40-character source commit>",
    "configurationId": "voice-config-v1",
    "provider": "google",
    "model": "gemini-live-2.5-flash-native-audio",
    "deviceClass": "chrome-macos-wired",
    "mode": "task_planning",
    "language": "ja",
    "inputSource": "human",
    "humanParticipationConfirmed": true,
    "consentConfirmed": true,
    "reviewRef": "private-review-001",
    "measuredAt": "<actual ISO date>",
    "outcome": "success",
    "report": "attempt-001.json",
    "sha256": "<SHA-256 of the unchanged report>"
  }]
}
```

Record `failure` for wrong/missing tasks, incorrect dates, lost state, stuck/duplicate audio, crashes or unrecovered connections. Keep failures in the denominator. A failed connection before an export is possible uses `report: null`; retain its private diagnostic record under `reviewRef`. Mark unjudged content `unreviewed`; the summary suppresses success/failure rates until all outcomes in that group have been reviewed.

```sh
shasum -a 256 /private/evidence/attempt-001.json
node scripts/verification/conversation-benchmark.mjs /private/evidence/manifest.json /private/evidence/summary.json
```

The offline command checks file hashes, duplicate attempt/report/session IDs, explicit human confirmation, valid timestamps and finite nonnegative samples. It pools **raw observations**, never averages session percentiles, and keeps source/configuration/provider/model/use-case/language/input/device groups separate. Hashes provide integrity, not proof that self-reported metadata is true. Publish only a reviewed aggregate.

## Timing definitions

All local marks use the browser's monotonic clock. Percentiles use nearest rank. Missing observations are shown as unavailable, never zero milliseconds. Each timing has its own sample count.

| Field | Boundaries | Limitation |
| --- | --- | --- |
| `playbackSignal` | Detected user speech end → first non-silent output PCM observed after assistant start | Post-gain AudioWorklet tap delivered to main thread; includes scheduling/tap delay. Not physical speaker or Bluetooth output. |
| `subtitleArrival` | Detected user speech end → first non-empty assistant transcript event | Not DOM paint. Partial/final repeats contribute only the first sample. |
| `interruptionSilence` | User speech start during recently observed output → at least 30 ms of output silence | Peak threshold 0.001; main-thread observation. Not the fast stop-command execution time. Missing tap data is not a successful stop. |

The VAD endpoint can itself lag the person's actual last sound. Values do not establish mouth-to-ear latency. Use a synchronized hardware recording for physical-device acceptance. Captures are bounded at 5,000 observations per metric; dropped samples are disclosed and prevent a complete latency-target claim. Fewer than 100 playback samples do not meet the benchmark's latency evidence threshold. Target p50 <1,500 ms and p95 <3,000 ms is a goal for this benchmark, not a guarantee. The older strict [release gate](../scripts/release/reality.mjs) remains unchanged and has different thresholds.

## Coverage and execution order

Maintain a private case sheet with language, case, environment, outcome, fault observed, review reference and report ID. Pre-register cases before executing; keep every attempt, including retries.

1. Reproduce the same voice/task demo ten times. Evaluate each task state against the authored input. The separate ten-run task-UI check does not complete this voice requirement.
2. Reach at least 100 live human conversations, then expand toward 300. Cover Japanese, English, numbers, names, long utterances, quiet speech, fast speech, silence, backchannels, corrections, user interruption and interruption during AI playback. Do not infer coverage solely from turn counts.
3. Run independent 15-, 30- and 60-minute sessions in a budgeted environment. At regular checkpoints inspect sound/lip alignment, socket state, heap/resource counts, subtitle duplication, context growth and return of old responses. Elapsed duration alone is not a passing stability result.
4. Exercise provider unavailability, expired tokens, mic denial, device switching, Bluetooth loss and background/resume. Distinguish controlled injected failures from actual device/network observations. Check cleanup, user-visible errors and absence of false task success.
5. Compare results for the same source/model/configuration, including failed turns and sessions with missing timing. A fast response with the wrong task is still a task failure.

This is an evaluation procedure for agreed internal/customer sessions, not a tester-recruitment campaign. No unsolicited outreach, personal social accounts or invented participants are used.
