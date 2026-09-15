# Contributing to AI-meeting

Contributions are welcome in English or Japanese. A clear bug report, a better setup explanation, a translation, or a reproducible browser test can be as useful as a new feature.

## Start with a working demo

Use Node.js 22 (minimum 20.19.0) and pnpm 10.12.2, pinned in `package.json`:

```sh
corepack prepare pnpm@10.12.2 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm dev:oss
```

Open http://localhost:5173/vrm-demo.html. No cloud credentials are needed for avatar/audio playback. The complete AI conversation flow requires separately configured speech and AI services; follow the [README](README.md#connect-an-ai-provider).

## Choose a contribution

- Report a problem with the bug template, including exact steps and the browser/OS.
- Explain the user's problem before proposing a new feature. For a substantial API or architecture change, open a feature request before implementing it.
- Keep a pull request focused. State the previous behavior, the new behavior, and how you verified the change.
- Include regression coverage when fixing behavior that could break again. UI text and documentation changes can use focused manual verification.

## Project map

| Directory | Responsibility |
| --- | --- |
| `apps/web` | Browser UI and application integration |
| `packages` | Audio, conversation, avatar, behavior, and shared contracts |
| `providers` | AI connection adapters |
| `avatar-providers` | VRM, canvas fallback, and optional avatar adapters |
| `services` | Token broker, local agent, and evaluation services |
| `characters`, `personas` | Character metadata/assets and conversation scenarios |

Keep provider-specific SDK work in the adapters. Avatar lip sync should consume the shared speaker output; it should not create a second playback path. Preserve cancellation across audio, captions, and gestures. Changes to `strict_local` must preserve its cloud-connection boundary.

## Verify your changes

Run the checks used by CI:

```sh
pnpm typecheck
pnpm test
pnpm build:oss
```

The OSS build audits the files actually emitted, including third-party notices. Test a modified interaction in the browser as well. Describe what you observed and distinguish fixture audio from a real AI conversation. CI does not establish perceived lip-sync quality, model rights, or reception on another meeting participant's device.

## Code, assets, and privacy

By contributing application-specific code, you agree to license that contribution under the project's [Apache-2.0 license](LICENSE). Only submit material you have the right to contribute. Third-party material retains its original license: include its source, pinned version or hash, license text, and a description of any changes. Follow [NOTICE](NOTICE) for component exceptions. A model's license is separate from the renderer's license.

Do not include credentials, `.env` values, meeting recordings, participant details, or private conversations in an issue, pull request, or screenshot. Use a small synthetic example to reproduce a problem. Report vulnerabilities through [SECURITY.md](SECURITY.md).

If AI tools helped with a contribution, review and understand the result, verify the behavior, and disclose assistance when it matters to understanding the work or its provenance. You remain responsible for the contribution.

## Discuss constructively

Be specific, kind, and patient. Critique the work rather than the person. Explain disagreements with examples, and credit contributors and upstream authors. Maintainers may ask to narrow a change or defer it until its behavior and licensing are clear.
