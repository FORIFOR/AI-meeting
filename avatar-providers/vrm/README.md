# @rcai/avatar-vrm — local VRM renderer

This provider renders a VRM 0.0/1.0 character in the browser with Three.js and
`@pixiv/three-vrm`. It maps the shared avatar state to humanoid bones,
expressions, gaze, spring bones, and audio-driven lip sync.

## Try it without an account

- [Hosted VRM preview](https://ai-meeting.web.app/vrm-demo)
- [45-second voice-to-task recording](https://youtu.be/qLenE6R7-nI)

The hosted preview needs no API key or microphone. Play the supplied test sound
or choose a local audio file; the selected files stay in the browser. It is a
renderer and audio preview, so a live AI conversation still needs a configured
provider in the self-hosted app.

## Run locally

```sh
pnpm install --frozen-lockfile
pnpm dev:oss
# open http://localhost:5173/vrm-demo.html
```

The OSS build uses the dedicated local settings and asset allowlist. It does
not enable cloud avatar or voice connections automatically.

## Use from an app

```ts
import { VRMAvatarProvider } from "@rcai/avatar-vrm";

const avatar = new VRMAvatarProvider({
  container: document.querySelector("#avatar")!,
  privacyMode: "strict_local",
});
await avatar.prepare(character);
await avatar.start();
speaker.tap.subscribe((frame) => avatar.pushAudio(frame));
```

`privacyMode: "strict_local"` rejects remote model resources and requires a
self-contained model. On WebGL failure, the application can select its named
local canvas fallback. See the [OSS distribution notes](../../docs/oss-vrm.md),
[validation record](../../docs/validation.md), and the repository
[license notes](../../NOTICE).

The bundled sample character has separate VRM permissions; importing another
model requires checking that model's license and embedded permissions.
