# Voice activity orb

The live session (including team sessions) and meeting relay/bot views use a liquid glass orb alongside the selected character. It replaces the fading state text so listening, thinking and speaking remain visible. The separate `/orb-preview` page is a labelled visual sample and never captures audio or calls an AI service.

- **Input:** the existing microphone or meeting PCM is reduced to a bounded RMS level; the listening state follows the conversation's speech activity, with a conservative level hint covering the short handoff before a VAD event arrives. The hint is visual only and never changes turn-taking.
- **Thinking:** the conversation's thinking state uses the linked Siri Wave settings. Generated speech without played PCM remains in the thinking state.
- **Output:** only the existing speaker playback tap activates output. Playback can continue after generation has ended. The label stays stable over pauses while the audio sink remains active.
- **Interrupt/mute/exit:** interruption clears output immediately. Microphone mute clears input but does not hide audible AI output. Ending, closed and error phases take priority over residual levels.

No additional microphone, audio context, upload, recording or external renderer API is introduced. The activity meter retains only level/timestamp numbers in memory. The renderer is loaded on demand, renders a single GPU pass at no more than 30 fps and 512 × 512 pixels, and releases its context/device on unmount. Hidden views stop drawing. Reduced-motion preferences use static poses; unsupported/lost WebGPU falls back to CSS glass with the same state labels. The fallback is a simpler rendering, not pixel-identical to WebGPU.

The glass shader, uniform layout and selected preset come from [LerSent001/orb](https://github.com/LerSent001/orb) at `047c58cc93587c21dac12183fc0fb1e4101c8e1a`, under MIT. See `apps/web/src/components/voice-orb/vendor/LICENSE`. Both browser distributions emit `ORB-THIRD-PARTY-NOTICES.txt`; the editor and its dependencies are not bundled.

Validation covers PCM-level extraction, input/output separation, stale-level decay, interruption/mute/exit precedence, accessible state updates, reduced motion, hidden-view suspension, GPU fallback and late initialization cleanup. Browser checks use the explicitly labelled preview; they do not count as new live-model or microphone acceptance sessions.
