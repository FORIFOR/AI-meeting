# AI Meeting first proof

There are two deliberately different first-proof paths.

## Fastest: no install, no account

Open the public task flow and save one task in this browser:

https://ai-meeting.web.app/#tasks

Then complete or defer it and reload the page. The proof here is deliberately narrow: the task change is persisted in this browser. It does not prove microphone capture, a cloud voice model, Meet/Zoom delivery, or cross-device sync.

The VRM preview is also available without an account, API key, or microphone:

https://ai-meeting.web.app/vrm-demo

## Local OSS path

After installing the pinned workspace dependencies:

```bash
pnpm first-proof
```

Open the forwarded/local Vite URL at `/vrm-demo.html`. This is the existing OSS-mode path: it prepares the OSS assets and does not require the token broker or a cloud provider for the local VRM/audio preview.

Build and audit the distributable OSS preview without starting a development server:

```bash
pnpm first-proof:verify
```

This runs the existing OSS build plus bundled-asset/license audit.

## Evidence boundary

- A saved browser-local task proves that IndexedDB persistence succeeded for that browser profile; it is not proof of team/device synchronization.
- The VRM preview proves the local renderer/audio path under the tested browser; it is not evidence of a live OpenAI/Gemini conversation.
- Cloud voice, meeting connectors, and hosted team features have separate credentials, billing/data terms, and validation procedures.
- Recorded demonstrations retain their own synthetic-input/real-provider disclosures; they are not substituted for live acceptance evidence.
