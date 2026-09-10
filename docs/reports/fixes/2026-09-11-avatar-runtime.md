# Avatar runtime delivery — 2026-09-11

The existing avatar-core package separates conversation events and played PCM from Live2D/VRM renderers. AudioWorklet output feeds the avatar through SpeakerOutput.tap. State, gaze, breathing, blinking and gestures are composed locally.

Changes:
- Meeting default participation is open (explicit addressed-only and caption observer remain available).
- Meeting and one-to-one behavior planning now use HeuristicSemanticPlanner; no remote request is made to choose avatar motion.
- Actual WebGL probing retries WebGL1 when WebGL2 fails, rejects lost contexts and releases temporary contexts.
- Meeting Live2D defaults to 30 fps with the existing 640-pixel framebuffer cap to bound software rendering cost.
- Bot reports selected renderer and model-prepare fallback.

Validation:
- 43 focused tests passed; web TypeScript and production build passed.
- scripts/avatar/validate-runtime.mjs, local headless Chrome using SwiftShader, 1280x720 viewport: actual Live2D rendered, 29.31 fps over a short synthetic PCM trial; mouth 0.8 during speech, 0 after interruption. This is not a sustained throughput benchmark or Meet receiver measurement.
- Screenshot and JSON saved under artifacts/avatar-validation.
- No paid meeting or AI API run.

Limits:
- Canvas emergency fallback still uses the existing 8 fps sprite sheets. It is not equivalent to real Live2D and is not claimed to be 30 fps.
- Hosted rendering/capture performance requires a real receiver test; launch flags alone do not establish GPU availability.
- Existing Hiyori model retained per user instruction; no original model was created.
- VRM adapter exists; Human GLB/TalkingHead and Audio2Face remain future additions, not shipped capabilities.
