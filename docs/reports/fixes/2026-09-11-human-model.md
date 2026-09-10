# Human model registration

Sora now uses the MPFB sample from met4citizen/TalkingHead. Upstream README explicitly licenses mpfb.glb under CC0. SOURCE.json records the pinned upstream revision, source SHA256, distributed SHA256 and modifications. Existing Yui is unchanged.

The model is local/static, fetched only when needed; no avatar API key or remote animation service is used. Facial targets outside the implemented mapping were removed and texture size limited to 1024px. The model remains about 25 MB, so first selection requires a larger download than Live2D previews.

Actual local Chrome/SwiftShader validation: displayed the rigged model, speech mouth 0.8, interruption mouth 0, approximately 20 fps in a short synthetic PCM trial at 640x360 framebuffer. Arm rest pose and camera were corrected after visual inspection. Sora is labelled trial availability; it is not represented as a high-quality photorealistic or sustained 30fps result. Tests: 18 passed, web typecheck/build passed.

Previous external model prerequisite is resolved by this asset. The only remaining requested external validation is real Hosted Meet/Zoom reception. The user's current tab has a blank meeting URL on Home, so no active test meeting could be established. No new paid bot was created because the prior user waiver remains in effect pending an explicit answer.

## Scope resolution

The earlier explicit user instruction says paid real-meeting tests are not required. Treat that test as waived/out of scope, not a repeated blocker. No new paid bot was created. Within that authorized scope, model registration and code validation are complete; real Hosted receive quality remains unmeasured and is not claimed verified.
