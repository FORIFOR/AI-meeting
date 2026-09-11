# AI-meeting

**Think out loud with an AI character.**

Organize a plan, rehearse an interview, or speak a new language. Talk at your own pace, interrupt to change direction, and choose the character and AI connection that fit your setup.

[Try the avatar demo](https://ai-meeting.web.app/vrm-demo) · [Website](https://ai-meeting.forifor.chatgpt.site) · [日本語](README.ja.md)

The **avatar/audio demo needs no API key**. It plays a test sound or your local audio file through a VRM character in your browser. Actual AI conversation requires a configured local AI runtime or a cloud provider.

[![Watch the 46-second AI-meeting demo: a VRM character, live Gemini responses, and saved tasks](https://ai-meeting.forifor.chatgpt.site/demo-poster.jpg)](https://youtu.be/sKWc8K2VHV4)

**[Watch the 46-second demo](https://youtu.be/sKWc8K2VHV4):** add tasks, interrupt, and confirm an update. The recording uses synthetic Japanese input (macOS Kyoko), real Gemini responses, and a VRM avatar in a dedicated recording layout. A script confirms proposals that exactly match the demo inputs; see [the recording method and validation](docs/validation.md).

## What you can do

- **Practice out loud.** Start from interview, English conversation, sales, tutoring, or free-talk scenarios.
- **Organize tasks by voice.** Add tasks, keep their deadlines in view, and confirm proposed changes when speech recognition needs a check.
- **Keep control of the conversation.** Stop playback and interrupt without bringing back the previous reply's captions or gestures.
- **Bring your character.** Open your own permitted VRM 0.0/1.0 model and audio locally. The demo does not upload those files.
- **Choose your AI.** The app has OpenAI Realtime, Gemini Live, and local provider adapters. The OSS build starts with local settings and blocks cloud connections in `strict_local` mode.

The public demo uses a separately licensed official pixiv VRM sample. The existing Live2D adapter and Yui configuration are retained as optional integrations. The hosted launch is an avatar/audio demo; connect your own AI provider in a self-hosted installation.

## Run the demo

Use **Node.js 22** and Corepack; the minimum supported Node version is **20.19.0**. The project pins **pnpm 10.12.2**.

```sh
git clone https://github.com/FORIFOR/AI-meeting.git
cd AI-meeting
corepack enable
corepack prepare pnpm@10.12.2 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm dev:oss
```

Open **http://localhost:5173/vrm-demo.html**, play a test sound, or choose a local audio file. `pnpm build:oss` creates the distributable site in `apps/web/dist-oss` and checks its bundled assets and license notices.

## Connect an AI provider

| Setup | What you need |
| --- | --- |
| Local conversation | A running local LLM, speech recognition, and speech synthesis. Model weights are separate downloads. The [local stack script](scripts/local-stack.sh) and [agent configuration](services/agent/src/config.ts) define the supported paths and environment variables; the provided native voice helper is for macOS. |
| OpenAI Realtime | Your own provider account and API key configured in the token broker. |
| Gemini Live | Your own Gemini API key with `GEMINI_BACKEND=developer`, or a separately configured Vertex AI project. |

For cloud adapters, copy [the broker environment example](services/token-broker/.env.example) to `services/token-broker/.env`, configure your chosen provider, and run `pnpm dev`. Select the VRM sample for the supplied avatar, then choose the provider in the app. Cloud services have their own availability, billing, and data-processing terms. Keep keys on the broker and out of frontend code and commits.

Live2D and cloud avatar integrations are optional. Their SDKs, assets, credentials, and service terms are separate from the default VRM distribution.

## Status and validation

**Beta.** On September 12, 2026, 1,025 automated tests across 114 files passed, along with type checking. The OSS build includes a distribution and license audit. Local avatar checks passed 50 Japanese audio samples, 20 interruptions, and a 60-minute run using fixture audio and the real renderer/audio runtime.

For 20 paired audio samples, the p95 of VRM's additional local playback delay relative to Live2D was **+6.3 ms**. This measures local audio processing, **not AI response time**. Naturalness judged by people, a 60-minute live AI conversation, and audio/video received on a separate Meet/Zoom participant's device are not covered by that result. Meeting connectors require their own setup and validation. See [validation details and the recorded Gemini task demo](docs/validation.md).

## License

Application-specific code is licensed under [Apache-2.0](LICENSE), subject to the exceptions in [NOTICE](NOTICE). Third-party code, model weights, artwork, and services retain their own terms. The bundled [VRM sample](characters/vrm-sample/LICENSE.md) has separate model permissions. Live2D components and assets are separately licensed; Attendee-derived material remains under Elastic License 2.0. The app license does not grant rights to those components or hosted services.

## Contribute or try it with your team

Try a scenario, report a reproducible problem, or improve a provider, language, or character integration. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

Have a use case for a classroom, coaching program, or sales team? [Start a public pilot discussion](https://github.com/FORIFOR/AI-meeting/issues/new?template=team-pilot.yml) with non-confidential requirements. This is an early product; hosted support and commercial terms can be discussed for the actual use case.

If the project is useful, a GitHub star helps you find it again and makes it easier for others to discover.
