# One-to-one UX gate

Run `pnpm ux-gate path/to/measured-evidence.json`. No argument deliberately reports NOT_VERIFIED and exits 1. This command does not create a paid AI or meeting session.

Evidence has `samples` arrays (at least 20 finite nonnegative observations each): `startupMs`, `responseMs`, `interruptionMs`, `lipSyncOffsetMs`, `speechDetectionMs`, `avatarFps`. `incidents` contains observed integer counts for `doubleSpeech`, `stuckSpeaking`, `stuckListening`. Do not use synthetic fixture values as release evidence.

Startup measures Talk activation through first audible response. Response measures end of human speech through first audible response. Interruption measures local speech detection through actual playback stop. Lip sync measures absolute audible/visible offset, not mouth-close latency. Speech detection measures human speech onset through visible listening response. FPS uses the lower 5th percentile (higher is better), unlike latency's upper 95th percentile.

Targets: startup p95 <5000ms; response p50 <700ms and p95 <1300ms; interruption p95 <150ms; lip sync p95 <80ms; listening response p95 <100ms; FPS p05 >=30; all listed incidents zero.

Existing runtime telemetry covers some timings but does not automatically produce this full evidence format. End-to-end startup, lip-sync offset and representative FPS collection remain unverified. The gate checks supplied data; it does not establish measurement provenance or replace user evaluation. Paid Meet/Zoom and 15x3 user testing remain waived by the user, not marked as passed.

## Local playback cancellation

With Vite on 127.0.0.1:5185, run `node scripts/ux/local-playback.mjs` on macOS with Chrome installed. External requests are blocked. Twenty synthetic-tone trials exercise the actual SpeakerOutput and AudioWorklet, assert queue clearing and stale-generation rejection, and measure the time from cancel invocation to the first silent rendered PCM batch received on the main thread. A zero-valued test source keeps the tap active after removal of the tone source. This does not measure physical speaker latency, microphone/VAD onset, model response or perceptual lip sync, and must not be supplied as complete UX-gate evidence.
