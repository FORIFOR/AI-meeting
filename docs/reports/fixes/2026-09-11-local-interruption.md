# Local interruption despite network failure

The explicit tap interruption path stopped the sink immediately but awaited remote cancellation before updating the avatar and turn state. A stalled/rejected request could leave the visible character speaking. Local interruption now completes before issuing the remote cancellation; delayed cancellation cannot interrupt a later local turn through this awaiting continuation.

Validation: 36 conversation/audio tests pass, including pending and rejected network cancellation regression cases. Conversation-core typecheck and production build pass. Real local Chrome AudioWorklet trials (20 synthetic tones, external requests blocked) measured cancel invocation to first silent PCM batch at p95 10.8ms, max 10.8ms; all 20 stale generations rejected. This excludes microphone/VAD, physical output-device delay, cloud and meeting transport. It is not full end-to-end UX acceptance.
