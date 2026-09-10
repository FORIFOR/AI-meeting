# Avatar follow-up delivery

## Implemented

- Canvas Yui fallback now decodes two silent 30 fps WebM loops (120 frames each) instead of the 32-frame 8 fps sprite sheets. The same Live2D model is rendered offline; body/eye motion remains pre-rendered, while played PCM controls the blend between closed/open mouth poses. This is a graceful fallback, not full Live2D deformation or phoneme-level animation.
- No cloud AI or GPU animation service is used for fallback generation/playback. The first assets total approximately 169 KB. Video playback errors fall back to existing character artwork; resources stop on disposal.
- `human-glb` renderer added to avatar-core, factory, character manifest parser and character preview. It supports self-contained GLB files with ARKit jawOpen or Oculus viseme_aa morph targets, independent eye blinks, gaze, smile/frown and head rotation. Models lacking mouth morph targets are rejected explicitly.
- Human rendering reuses three.js and the existing PCM/motion runtime. TalkingHead and Audio2Face are not dependencies. No new person model is advertised or shipped.

## Validation

- Human/VRM/generation/WebGL unit tests: 15 passed.
- Web and VRM package typechecks and production build pass.
- `scripts/avatar/validate-fallback.mjs`: local Chrome decoded about 29.3 fps, speech mouth parameter 0.8, interruption mouth parameter 0; screenshot visually checked. An initial black-background export was corrected before deployment.
- `scripts/avatar/validate-human.mjs`: a synthetic GLB with a jaw morph was loaded and rendered in real headless Chrome; cleanup removed its canvas. This validates integration/lifecycle, not the appearance of a real human character.

## External prerequisites still pending

- Hosted Meet/Zoom receiver test requires the user's answer on paid testing and a currently active meeting URL. Earlier instruction waived paid tests; no paid meeting was started.
- A licensed rigged person GLB is needed to offer a Human character. User has been asked whether to leave it unregistered or provide a model path. Existing Live2D characters remain per user instruction.

## Registering a human model

Use an ordinary character pack with `manifest.json` renderer `human-glb`, model pointing to the GLB, and existing character voice/persona/motion metadata. Register that pack in `characters/index.ts` only once its asset license and real-model appearance are checked. Keep the model in the character pack; no user API key is required by this renderer. Facial names currently supported are standard ARKit names listed in `humanFaceWeights`, plus `viseme_aa`. This implementation does not claim full ARKit-52, Mixamo animation retargeting, or phoneme recognition.
