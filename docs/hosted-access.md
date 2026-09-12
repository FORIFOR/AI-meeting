# Hosted voice and durable tasks

The public app supports task management without registration. Tasks are stored in IndexedDB in the current browser, including the recording date of a deadline. A JSON backup can be exported and merged back after confirmation. Clearing browser data removes local tasks. Signing in does not upload or synchronize them between devices.

Voice task changes use the same store. Transactions serialize changes across tabs; stale edits and conflicting backups fail visibly instead of silently overwriting newer data. Proposals needing clarification stay in memory until confirmed. Only applied task changes are persisted; the task store contains no audio or conversation transcripts.

## Verified, limited voice access

Hosted access is an explicitly enabled extension to demo-only mode. Other paid broker routes remain blocked in demo-only mode. The new route verifies a Firebase ID token, including revocation checks, and requires a verified email address. Firebase credentials remain in session storage. The browser sends its ID token only to the configured broker's hosted-session endpoint; Google provider credentials stay on the server.

The broker reserves capacity in a Firestore transaction before returning a two-minute, single-use relay ticket. The ledger survives restarts and is shared across replicas. It stores a hash of the user ID, a hash of each ticket, its UTC date, expiry, duration, and consumed state. Invalid or unavailable storage fails closed. Failed or abandoned connections still consume a reservation. Deleting an account leaves the historical hashed reservation record; it does not refund capacity.

Current public settings are 180 seconds per session, one reservation per user per UTC day, and 30 reservations across all users per UTC month. Internal live verification also consumes this capacity. These are usage limits, not a yen-denominated hard cap on the whole Google Cloud project. No payment, paid plan, or automatic billing for users is implemented.

The relay enforces duration on the server, caps input audio and text, denies embedded video/media, and bounds response tokens, audio and turns. Hosted browser requests cannot enable Google Search, cached context, or session resumption. The server closes the upstream connection on termination; the browser treats hosted-limit closures as terminal and releases its session resources.

Audio, speech and tasks used in a voice session are sent to Google's voice model. The app's account panel explains this before registration. Task-only operation does not send the task workspace to that model.

## Operator configuration

Hosting requires a configured Firebase project, email/password Auth, authorized frontend domains, the Firebase Hosting public SDK configuration, Vertex permissions, and Firestore permissions for the broker service account.

| Variable | Required value or bounds |
| --- | --- |
| `RCAI_PUBLIC_DEMO_ONLY` | `1` |
| `RCAI_HOSTED_ACCESS` | `1` (disabled by default) |
| `GEMINI_BACKEND` | `vertex` |
| `GOOGLE_CLOUD_PROJECT` | Operator's project |
| `RCAI_HOSTED_FIRESTORE_DATABASE` | Existing Firestore database ID |
| `RCAI_HOSTED_SESSION_SECONDS` | Integer 30–300; default 180 |
| `RCAI_HOSTED_USER_DAILY_SESSIONS` | Integer 1–3; default 1 |
| `RCAI_HOSTED_MONTHLY_SESSIONS` | Integer 1–1000; default 0 disables access |

The frontend must be built with `VITE_RCAI_BROKER_URL` matching that broker. The OSS build excludes the Firebase account UI and SDK, so it remains an independent, key-free distribution. Do not clear the usage ledger to retry a failed session or change limits without reviewing the operating budget.

## Reproduce validation

Run the ordinary suite and the browser task check against a preview of the built application:

```sh
pnpm typecheck
pnpm test
pnpm build:oss
APP_URL=http://127.0.0.1:5180/#tasks node scripts/verification/task-workspace-browser.mjs
node scripts/verification/microphone-browser.mjs
```

Set `CHROME_PATH` when Chrome is installed outside the default macOS location. Browser checks run in their own headless profile. They do not use a personal browser session.

`scripts/verification/hosted-real.mts` uses application-default administrator credentials, `GOOGLE_CLOUD_PROJECT`, `BROKER_URL`, and `INPUT_PCM` (mono 16 kHz signed 16-bit little-endian PCM). It creates and deletes a disposable Auth user, reserves one real hosted session, and waits for server termination. It never sends verification email. `FIREBASE_CONFIG_URL` can point to the operator's Firebase Hosting `/__/firebase/init.json`; its default is the public AI-meeting app.

`scripts/verification/hosted-browser.mts` tests login and the normal app's MicCapture → Gemini → task tools → IndexedDB path. It expects the built preview on port 5180, allowed by the selected broker's CORS policy, and `artifacts/hosted-access/task.wav` containing synthetic Japanese speech. The authored fixture says: 「新しいタスク名は資料確認です。期限は9月15日です。一件追加してください。」 Use at least 15 seconds of leading silence for setup and 30 seconds of trailing silence. The script injects that file as a WebAudio microphone stream, confirms only a proposal matching that fixture, checks persistence after reload, and deletes its disposable account in cleanup. This is synthetic input to the real app and provider, not a person speaking into physical hardware.

Reports and screenshots are written under ignored `artifacts/`. Publish only reviewed, sanitized evidence. Auth tokens, passwords, personal audio and customer tasks must not be added to the repository.
