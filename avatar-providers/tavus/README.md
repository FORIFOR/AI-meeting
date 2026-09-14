# @rcai/avatar-tavus — optional cloud adapter

This provider connects the shared `AvatarProvider` interface to Tavus CVI. The
browser joins the Daily room returned by the broker and sends assistant audio
through the CVI Interactions Protocol (`conversation.echo`); Tavus supplies the
synchronized video and audio.

## Requirements

1. Run the token broker and configure Tavus credentials there.
2. Keep all keys on the broker and out of browser code and commits.
3. Use a permitted replica/persona and review Tavus and Daily availability,
   billing, and data-processing terms.

The browser calls `POST /api/avatar/tavus/conversation` through the broker. A
missing key returns `BLOCKED_BY_TAVUS_KEY`; `strict_local` and the OSS build do
not connect to this cloud path. The hosted demo uses the local VRM renderer.

## Use from an app

```ts
import { TavusAvatarProvider } from "@rcai/avatar-tavus";

const avatar = new TavusAvatarProvider({
  brokerUrl: "http://localhost:8787",
  container: document.querySelector("#avatar")!,
});
await avatar.prepare(character);
await avatar.start();
assistantAudio.subscribe((frame) => avatar.pushAudio(frame));
```

Feed assistant frames to this adapter, not the local speaker tap. Call
`endSpeech()` after each assistant utterance so the CVI echo message is marked
complete; `interrupt()` sends the CVI interrupt event. Text-only experiments
can use `speakText()`.

See the [integration contract](../../docs/integration-contracts.md),
[token-broker example](../../services/token-broker/.env.example), and the
[business inquiry form](https://ai-meeting.forifor.chatgpt.site/#business) for
deployment or customization work.
