# One-to-one conversation UX

Implemented avatar-first conversation screen: notes and tasks behind a Notes toggle, new-install subtitles off (saved preferences retained), and camera toggle inside settings for Thinking Meeting. Thinking Meeting ends without a paid evaluator call and presents user-editable conclusion / next-step notes. Only explicitly saved notes are stored on this device, scoped to character; Continue explicitly supplies them as prior reference. Home supports deleting them. Transcripts remain available behind a disclosure on the result screen.

Validation: workspace typecheck, production build, 11 focused tests for runtime, home start action, memory isolation/deletion/length limits and gate missing-data rules. Local desktop and mobile rendering performed with external requests blocked. No paid meeting or model test initiated.

`pnpm ux-gate` intentionally returns NOT_VERIFIED with missing measurements. Actual five-second start, sub-700ms median turn taking, sub-150ms barge-in and perceptual lip-sync quality are not certified by unit tests. Existing motion and local interruption infrastructure is retained; no new MotionSync model assets or phoneme quality certification is claimed. Homepage portrait is still static. Full P0 experiential acceptance remains unverified; paid meeting / user tests previously waived are not restored as requirements.
