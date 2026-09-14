# AI Meeting

**Turn spoken plans into tasks you can pick up next time.**

An open-source **voice-to-task** app for interruptible AI conversations, VRM avatars, and browser-local task persistence.

Tell an AI character what needs doing, interrupt to change a plan, and keep the resulting tasks. Add, complete, or defer them by voice; check uncertain changes before they are saved.

[Try tasks — no account](https://ai-meeting.web.app/#tasks) · [Explore the VRM preview](https://ai-meeting.web.app/vrm-demo) · [Watch the 45-second demo](https://youtu.be/qLenE6R7-nI) · [Questions and use cases](https://github.com/FORIFOR/AI-meeting/discussions) · [日本語](README.ja.md)

[![8-second preview: a VRM avatar hears a spoken task change and the task list updates](docs/validation-assets/demo-preview.gif)](https://youtu.be/qLenE6R7-nI)

*Recorded demonstration: synthetic Japanese input, real Gemini responses, a dedicated recording layout, and a script that confirms proposals matching the input. [Recording method and limits](docs/validation.md).*

*The inline preview is an 8-second excerpt of the recorded flow; open it for the full 45-second demonstration.*

## Try it before installing

| Start here | What you get |
| --- | --- |
| [Save your first task](https://ai-meeting.web.app/#tasks) | Free, no registration. Add, complete, defer, and reopen tasks saved in this browser. JSON backup; no automatic device sync. |
| [Talk to the AI](https://ai-meeting.web.app/) | Verified email required. Up to 3 minutes, once per UTC day, within shared capacity. No automatic billing. |
| [Explore voice and VRM](https://ai-meeting.web.app/vrm-demo) | No account, API key, or microphone. Play recorded or local audio with the avatar. |

For teams, [shared workspaces](https://ai-meeting.web.app/#team) include invitations, roles, and task synchronization in a limited five-member, 30-day profile. [Scope and acceptance evidence](docs/team-deployment.md).

## Building a voice app? Read these parts

- [Task validation](packages/conversation-core/src/tasks.ts): tie tool calls to quoted user statements and keep unverified changes pending.
- [Persistent tasks](apps/web/src/state/taskWorkspace.ts): report success after the IndexedDB transaction completes; reject stale edits from another tab.
- [Audio-driven UI](apps/web/src/session/voiceActivity.ts): distinguish received audio from actual playback, so the orb stays in sync with the reply. [Interactive visual sample](https://ai-meeting.web.app/orb-preview).

### Avatar integrations

Choose the rendering path that matches your privacy and deployment needs. The hosted preview uses the local VRM path; optional cloud adapters never connect without your own broker configuration.

| Path | What is included | Requirements and terms |
| --- | --- | --- |
| [VRM (local)](avatar-providers/vrm) | Three.js + `@pixiv/three-vrm`, local model/audio preview, and browser-local lip sync | WebGL-capable browser and a permitted VRM 0.0/1.0 model. The [hosted preview](https://ai-meeting.web.app/vrm-demo) needs no account or API key. |
| [Live2D (optional)](avatar-providers/live2d/README.md) | Cubism renderer, MotionStack gestures, and analyzer/MotionSync lip sync | Cubism Core, a permitted model, and separate Live2D SDK/material terms. MotionSync needs its separately downloaded Core. |
| [LiveAvatar (optional)](avatar-providers/liveavatar/src/LiveAvatarProvider.ts) | HeyGen LiveAvatar streaming adapter over LiveKit | Your broker configuration, provider credentials, and HeyGen/LiveAvatar service and data-processing terms. |
| [Tavus (optional)](avatar-providers/tavus/src/TavusAvatarProvider.ts) | Tavus CVI adapter over Daily | Your broker configuration, provider credentials, and Tavus/Daily service and data-processing terms. |

**Useful for your own project? Star this repository to keep it handy.** [Implementation and deployment inquiries](https://ai-meeting.forifor.chatgpt.site/#business) use a private form.

[![CI](https://github.com/FORIFOR/AI-meeting/actions/workflows/ci.yml/badge.svg)](https://github.com/FORIFOR/AI-meeting/actions/workflows/ci.yml) · [Beta release](https://github.com/FORIFOR/AI-meeting/releases/tag/v0.2.0-beta.1)

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

**Beta.** On September 13, 2026, 1,099 automated tests across 124 files passed, along with type checking. The OSS build includes a distribution and license audit. Earlier checks with the VRM constraint sample passed 50 Japanese audio samples, 20 interruptions, and a 60-minute run using fixture audio and the real renderer/audio runtime. The new AvatarSample_B was checked in the browser and in the 45-second real Gemini recording; that model has not yet had its own 60-minute soak test.

For 20 paired audio samples, the p95 of VRM's additional local playback delay relative to Live2D was **+6.3 ms**. This measures local audio processing, **not AI response time**. Naturalness judged by people, a 60-minute live AI conversation, and audio/video received on a separate Meet/Zoom participant's device are not covered by that result. Meeting connectors require their own setup and validation. See [validation details and the recorded Gemini task demo](docs/validation.md).

## License

Application-specific code is licensed under [Apache-2.0](LICENSE), subject to the exceptions in [NOTICE](NOTICE). Third-party code, model weights, artwork, and services retain their own terms. The bundled [VRM sample](characters/vroid-b/LICENSE.md) has separate model permissions. Live2D components and assets are separately licensed; Attendee-derived material remains under Elastic License 2.0. The app license does not grant rights to those components or hosted services.

## Business inquiries and contributions

Try a scenario, report a reproducible problem, or improve a provider, language, or character integration. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

For **paid setup, customization, or operational support**, [start a business inquiry](https://ai-meeting.forifor.chatgpt.site/#business). Describe the work you want to improve and the support you need. We will assess feasibility, scope, delivery timing, and fees for that use case before work begins. The application is currently a developer beta; this is not a ready-to-use hosted subscription. Inquiries use a private form; do not include confidential material.

For questions and non-confidential use cases, use [GitHub Discussions](https://github.com/FORIFOR/AI-meeting/discussions). Use the private form for business details or anything that should not be public.

If the project is useful, a GitHub star helps you find it again and makes it easier for others to discover.
