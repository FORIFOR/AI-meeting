# Native audio responses and meeting framing

The controller previously interrupted Gemini responses without a text-detected address. Continuous Gemini now owns turn-taking according to the existing system prompt. A fresh room utterance is required; mute/admission checks still control outgoing audio. Caption observer mode retains explicit activation. Captions no longer submit the same question as a second text request. Fresh audio resets the consecutive-response cap without requiring transcription.

Yui's bundled 480×800 portrait contains substantial blank space above the head. Meeting framing renders its upper-body region into the full canvas, with the same background across the camera frame. Character selection retains its existing framing. GPU fallback preserves the selected artwork.

Validation: 70 automated tests passed (controller greeting/native audio, participation policy, meeting core); web typecheck and production build passed. Headless Chrome rendered the actual canvas provider at 1280×720 for visual inspection. Firebase hosting deployment succeeded. No new paid Meet session was run; end-to-end audibility in Meet remains unverified. Existing sessions need to be ended and rejoined to load the new code. The meeting canvas remains a static character image, not animated Live2D.
