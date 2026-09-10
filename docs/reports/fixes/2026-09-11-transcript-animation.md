# Transcript echo and Yui animation

Platform captions retranscribed Yui's generated voice and were displayed next to Gemini's own assistant transcript. The controller now excludes captions whose normalized speaker name matches the selected character's names. Human captions remain visible; Yui's own words are not fed into meeting memory as a new participant question.

Meeting rendering now prefers Live2D when WebGL is available. GPU-limited browsers use two bundled animation sheets rendered from the same Yui Live2D model (32 frames per sheet, four-second idle loop). The fallback supports blinking, subtle head motion and audio-controlled mouth-open/closed poses. It is a limited pre-rendered fallback, not full live expression generation. Other characters retain their existing fallback behavior. Both sheets total about 671 KB. Regeneration: run the web Vite server on localhost:5185 and `node scripts/avatar/render-yui-animation.mjs` with Chrome available (CHROME_PATH override supported).

Validation: 20 controller tests passed, web typecheck and production build passed. Headless Chrome with --disable-gpu verified idle frames change, blink frames differ, the speaking pose opens the mouth, and stopping removes the canvas. Actual Google Meet receiver rendering has not been observed for this update; new sessions load the deployed assets.
