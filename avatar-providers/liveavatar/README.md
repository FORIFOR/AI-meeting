# @rcai/avatar-liveavatar — optional cloud adapter

This provider connects the shared `AvatarProvider` interface to HeyGen
LiveAvatar in LITE/custom mode. LiveAvatar renders the video and animates the
face itself; the adapter sends assistant PCM over its command WebSocket and
receives the synchronized LiveKit media track.

**Useful for your project?** [Star AI Meeting on GitHub](https://github.com/FORIFOR/AI-meeting) · [Discuss paid integration](https://ai-meeting.forifor.chatgpt.site/#business)

## Requirements

1. Run the token broker and configure the provider's credentials there.
2. Expose the broker URL to the browser; never put a provider key in frontend
   code or commits.
3. Use a permitted avatar and accept the provider's availability, billing, and
   data-processing terms.

The browser calls `POST /api/avatar/heygen/session` through the broker. A missing
key returns `BLOCKED_BY_HEYGEN_KEY`; `strict_local` and the OSS build keep this
cloud path disabled. The hosted demo uses the local VRM renderer instead.

## Use from an app

```ts
import { LiveAvatarProvider } from "@rcai/avatar-liveavatar";

const avatar = new LiveAvatarProvider({
  brokerUrl: "http://localhost:8787",
  container: document.querySelector("#avatar")!,
});
await avatar.prepare(character);
await avatar.start();
assistantAudio.subscribe((frame) => avatar.pushAudio(frame));
```

Feed assistant frames to this adapter, not the local speaker tap. The returned
LiveKit audio/video is the synchronized output. `endSpeech()` flushes the last
chunk and sends the provider's speech-end command; `interrupt()` stops the
current utterance.

See the [integration contract](../../docs/integration-contracts.md),
[token-broker example](../../services/token-broker/.env.example), and the
[business inquiry form](https://ai-meeting.forifor.chatgpt.site/#business) for
deployment or customization work.
