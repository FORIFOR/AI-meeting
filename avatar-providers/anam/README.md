# Anam audio passthrough renderer

This optional renderer preserves the selected character's identity. The broker maps
`character.manifest.id` to a provisioned avatar; the browser never accepts an Anam
API key or overrides the server's avatar mapping.

The adapter is disabled by default. Configuring the broker key and character map
only makes the option available; it does not choose it. In the character screen,
the user must select **自然な表示**, whose label and description explain that
AI reply audio is sent to **Anam** and may contain meeting information. This
per-character preference is saved for later conversations. Selecting **軽量表示**
disables that avatar integration for later conversations. The preview always
uses the local renderer and never opens an Anam session. `strict_local` and the
OSS build keep this renderer disabled even when a natural preference was saved.

Only AI reply audio enters this adapter; the SDK microphone input is disabled.
Local avatar rendering does not determine the separate conversation provider's
data handling. Before enabling this optional service for a deployment, confirm
the applicable service contract and permission for the chosen avatar material.
Provisioning a key or generating a portrait is not evidence of those permissions.

`prepare` obtains a session token; `start` opens an SDK session with microphone
input disabled, then waits for both media tracks and muted video playback. The
`synchronizedAudio` surface appears only after startup succeeds. Its source input
accepts provider PCM before playback, converts it to PCM16/16 kHz/mono in a
stateful stream, and finishes the input sequence on `endSourceTurn`. The normal
`pushAudio` speaker tap intentionally does nothing: forwarding playback upstream
would create an audio feedback loop. SpeakerOutput / the media bridge owns the
returned audio track's audible output.

The SDK exposes neither a passthrough turn identifier on AV output nor an output
playback-complete acknowledgement. `endSourceTurn` marks input completion only.
On interruption this provider discards pending source audio, stops the remote
session and all local tracks, and reports a failure so its owner can restore the
same character's local renderer. Never replay already-submitted speech during
that fallback. Integrations requiring a precise output utterance EOF must use
the local renderer until an appropriate output-completion contract is available.

Startup is bounded (9 seconds per phase by default), SDK start retries are
disabled, and local media cleanup occurs immediately even if remote cleanup
hangs. `strict_local` refuses token creation and SDK initialization.

Anam consumes at least 800 ms of input audio duration before starting frame
generation; this renderer is a visual option, not a guaranteed latency
improvement. Session duration is billable even while idle. Source sample rates
other than 16 kHz are present in the current SDK contract, but this adapter uses
the documented 16 kHz example until other rates are verified against a real
account. No paid integration success is implied by the mocked test suite.

Verified against `@anam-ai/js-sdk@4.27.0` and official documentation:

- [Audio passthrough](https://anam.ai/docs/javascript-sdk/examples/custom-tts)
- [Events](https://anam.ai/docs/javascript-sdk/reference/event-types)
- [Session token](https://anam.ai/docs/api-reference/sessions/create-session-token)
- [Avatar models](https://anam.ai/docs/introduction/models)
