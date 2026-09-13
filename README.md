# AI-meeting

[![CI](https://github.com/FORIFOR/AI-meeting/actions/workflows/ci.yml/badge.svg)](https://github.com/FORIFOR/AI-meeting/actions/workflows/ci.yml) · [Download beta / ベータ版](https://github.com/FORIFOR/AI-meeting/releases/tag/v0.2.0-beta.1)
**Think out loud with an AI character.**

Organize a plan, rehearse an interview, or speak a new language. Talk at your own pace, interrupt to change direction, and choose the character and AI connection that fit your setup.

[Open your tasks](https://ai-meeting.web.app/#tasks) · [Try the avatar demo](https://ai-meeting.web.app/vrm-demo) · [Website](https://ai-meeting.forifor.chatgpt.site) · [日本語](README.ja.md)

**Personal task management is free and needs no registration.** Add, edit, complete, or defer tasks; they are saved in this browser and restored in the next conversation. Export and restore a JSON backup. There is no automatic sync between devices.

**Team workspaces:** [open a team](https://ai-meeting.web.app/#team) with verified-email invitations, shared tasks, administrator controls, deletion and recovery. The limited profile supports five members for 30 days and three-minute Japanese voice sessions. [Technical scope and acceptance evidence](docs/team-deployment.md). Personal tasks stay separate.

The hosted voice experience requires a verified email account: up to 3 minutes per session, once per UTC day, subject to a shared capacity limit. There is no automatic billing. Longer conversations and meeting integrations require your own configured installation.

[![Watch the 45-second AI-meeting demo: a VRM character, live Gemini responses, and saved tasks](https://ai-meeting.forifor.chatgpt.site/demo-poster.jpg)](https://youtu.be/qLenE6R7-nI)

**[Watch the 45-second demo](https://youtu.be/qLenE6R7-nI):** add tasks, interrupt, and confirm an update. The recording uses synthetic Japanese input (macOS Kyoko), real Gemini responses, and a VRM avatar in a dedicated recording layout. A script confirms proposals that exactly match the demo inputs; see [the recording method and validation](docs/validation.md).

## What you can do

- **Practice out loud.** Start from interview, English conversation, sales, tutoring, or free-talk scenarios.
- **Organize tasks by voice.** Add tasks, keep their deadlines in view, and continue from the saved ledger next time. Confirm proposed changes when speech recognition needs a check; unconfirmed proposals are not persisted.
- **Keep control of the conversation.** Stop playback and interrupt without bringing back the previous reply's captions or gestures.
- **Bring your character.** Open your own permitted VRM 0.0/1.0 model and audio locally. The demo does not upload those files.
- **Choose your AI.** The app has OpenAI Realtime, Gemini Live, and local provider adapters. The OSS build starts with local settings and blocks cloud connections in `strict_local` mode.

The public demo uses a separately licensed official pixiv VRM sample. The existing Live2D adapter and Yui configuration are retained as optional integrations. The hosted app offers browser-local tasks, an avatar/audio preview, and a limited voice experience after verified sign-in.

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

**Enterprise evaluation:** the representative workflow is conversation → confirmed tasks → saved state → next session. Introduction demos, a paid pilot, and production have different acceptance conditions. [Readiness, cost assumptions and data flow](docs/enterprise-readiness.md) · [Conversation benchmark procedure](docs/conversation-benchmark.md). The 100-human-session milestone is not yet met.

## Status and validation

**Beta.** On September 13, 2026, 1,087 automated tests across 122 files passed, along with type checking. The OSS build includes a distribution and license audit. Earlier checks with the VRM constraint sample passed 50 Japanese audio samples, 20 interruptions, and a 60-minute run using fixture audio and the real renderer/audio runtime. The new AvatarSample_B was checked in the browser and in the 45-second real Gemini recording; that model has not yet had its own 60-minute soak test.

For 20 paired audio samples, the p95 of VRM's additional local playback delay relative to Live2D was **+6.3 ms**. This measures local audio processing, **not AI response time**. Naturalness judged by people, a 60-minute live AI conversation, and audio/video received on a separate Meet/Zoom participant's device are not covered by that result. Meeting connectors require their own setup and validation. See [validation details and the recorded Gemini task demo](docs/validation.md).

## License

Application-specific code is licensed under [Apache-2.0](LICENSE), subject to the exceptions in [NOTICE](NOTICE). Third-party code, model weights, artwork, and services retain their own terms. The bundled [VRM sample](characters/vroid-b/LICENSE.md) has separate model permissions. Live2D components and assets are separately licensed; Attendee-derived material remains under Elastic License 2.0. The app license does not grant rights to those components or hosted services.

## Business inquiries and contributions

Try a scenario, report a reproducible problem, or improve a provider, language, or character integration. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

For **paid setup, customization, or operational support**, [start a business inquiry](https://ai-meeting.forifor.chatgpt.site/#business). Describe the work you want to improve and the support you need. We will assess feasibility, scope, delivery timing, and fees for that use case before work begins. The application is currently a developer beta; this is not a ready-to-use hosted subscription. Inquiries use a private form; do not include confidential material.

If the project is useful, a GitHub star helps you find it again and makes it easier for others to discover.
