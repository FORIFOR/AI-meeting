# One-to-one UX gate

Run `pnpm ux-gate path/to/measured-evidence.json`. No argument deliberately reports NOT_VERIFIED and exits 1. This command does not create a paid AI or meeting session.

Evidence has `samples` arrays (at least 20 finite nonnegative observations each): `startupMs`, `responseMs`, `interruptionMs`, `lipSyncOffsetMs`, `speechDetectionMs`, `avatarFps`. `incidents` contains observed integer counts for `doubleSpeech`, `stuckSpeaking`, `stuckListening`. Do not use synthetic fixture values as release evidence.

Startup measures Talk activation through first audible response. Response measures end of human speech through first audible response. Interruption measures local speech detection through actual playback stop. Lip sync measures absolute audible/visible offset, not mouth-close latency. Speech detection measures human speech onset through visible listening response. FPS uses the lower 5th percentile (higher is better), unlike latency's upper 95th percentile.

Targets: startup p95 <5000ms; response p50 <700ms and p95 <1300ms; interruption p95 <150ms; lip sync p95 <80ms; listening response p95 <100ms; FPS p05 >=30; all listed incidents zero.

Existing runtime telemetry covers some timings but does not automatically produce this full evidence format. End-to-end startup, lip-sync offset and representative FPS collection remain unverified. The gate checks supplied data; it does not establish measurement provenance or replace user evaluation. Paid Meet/Zoom and 15x3 user testing remain waived by the user, not marked as passed.
