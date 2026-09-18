# Reviewed projects and verified calendar actions

This implementation integrates the source changes proposed by PRs #14–#16. It is not a claim of commercial acceptance, human conversation quality, or deployed Google OAuth approval.

## End-to-end product path

1. Open **案件** (`#projects`) and create a named project. Enter its goal, decisions, open questions and next steps; **確認して案件に保存** is the only note-save action.
2. **この案件の続きから話す** reads the latest saved revision before starting. Only that project's memo and tasks are given to the selected voice provider. Avatar identity is not the storage key. The voice provider and microphone must be configured separately.
3. All voice-origin task mutations are proposed, not saved, including operations whose quotation matches a transcript. Review the exact title/status/deadline and press **この変更を反映**. Declined or unconfirmed proposals are not persisted. A regex is not a natural-language correctness proof.
4. On ending a project conversation, review the existing note alongside the current conversation and saved tasks. Edit and confirm the note; raw audio and the full transcript are not written to the project database. Saving nothing leaves the previous memo unchanged.
5. Reload and select the same project. Its confirmed note and tasks remain in this browser even when the avatar changes. Clearing a project memo does not delete its tasks, execution history or Google events.
6. On a task choose **予定にする**, explicitly connect Google, and enter exact start/end times. Relative task dates are not guessed. Creating a registration draft does not contact Calendar. **この内容を承認してGoogleに登録** is a second, separate approval of the exact event and account.
7. The action is durably journalled before submitting the event. Only a readback matching event ID, summary, time bounds, private action ID and absence of guests produces **登録を確認済み**. A lost response is **結果不明**. Reconnecting, reloading or **登録結果を再確認（再送しません）** performs GET-only reconciliation, not another insert.

## Boundaries and storage

- Projects: IndexedDB `ai-meeting-projects-v1`, optimistic revision checks. Tasks: a separate `ai-meeting-project-tasks-<projectId>` database per project. Calendar actions: `ai-meeting-calendar-actions-v1`, transaction-based revision checks across tabs.
- No cross-device synchronization or server-side project backup is added. Browser storage can be cleared or evicted. Existing task JSON export is available per project; this is not a cloud backup of project notes.
- The calendar implementation supports one-time events in the connected user's **primary calendar**, without attendees, invitations, email sending, recurring events, event deletion, or arbitrary external tools. Full meeting content is never included in the event body.
- OAuth access tokens stay in memory and are cleared on navigation, disconnect or strict-local selection. Action history retains the account subject/email to prevent a different account approving an old draft. Local disconnect is not Google's server-side permission revocation.
- `strict_local` rejects new Google authorization and calendar requests. External account permissions still remain until revoked in the user's Google account.
- An indeterminate write is never automatically retried, even when a read returns 404. Resolve it in Google and reconcile. A definitive cancellation/deletion and reissue workflow is intentionally not implemented; do not silently replace an unknown action.
- Avatar model preparation is optional to voice startup. Each asynchronous renderer stage is bounded and cancelled on disposal. Late results are cleaned up and never reattach to a disposed session. A late avatar mirrors current state and generation without replaying old content or creating a synthetic latency measurement. A synchronized cloud audio renderer does not take over an already audible reply halfway through.
- Character metadata still participates in voice/persona configuration. Metadata fetch has a timeout; failure is not disguised as a fully configured voice session.

## Configure Google Calendar

Create an OAuth **Web application** client in the deployment's Google Cloud project, enable the Calendar API, and register the exact JavaScript origins (scheme, host and port). Set the public client ID in `apps/web/.env.local` for local work or the frontend build environment:

```sh
VITE_GOOGLE_CALENDAR_CLIENT_ID=<your-web-client-id>.apps.googleusercontent.com
```

Never put a client secret, access token or refresh token into Vite environment variables. Rebuild the frontend after changing the public client ID. Configure the consent screen and test-user access or verification as required by that Google project. The code does not supply those administrative approvals.

The UI requests `openid email` and `https://www.googleapis.com/auth/calendar.events.owned` through Google Identity Services. It loads `https://accounts.google.com/gsi/client` only after the first explicit connection action; a second click opens the account/consent popup. A restrictive deployment CSP must permit the required Google Identity and Calendar origins according to Google's documentation; do not weaken CSP globally. No server-side OAuth client secret is used by this browser token flow.

Official contracts:
- [GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Event IDs and fields](https://developers.google.com/workspace/calendar/api/v3/reference/events)
- [Insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) and [readback](https://developers.google.com/workspace/calendar/api/v3/reference/events/get)

## Automated verification

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build:oss
# In another terminal, start the local OSS preview:
pnpm --filter @rcai/web exec vite preview --mode oss --host 127.0.0.1 --port 5180
CHROME_BIN=/path/to/chrome node scripts/verification/project-browser.mjs
```

The browser script uses a fresh temporary browser context, a loopback-only preview, synthetic project/task text, and blocks third-party requests. It exercises creation, editing, task persistence, reload, memo deletion, and desktop/mobile overflow. It does not grant microphone permission, log into Google, call live models, or create actual calendar events. OAuth/REST unit tests use explicit HTTP fixtures. The next-day test advances the test clock, not a real calendar day.

## Human/live acceptance — still required

Use an operator-configured voice backend with sufficient quota; do not remove public hosted limits for this test. The public three-minute trial remains unchanged.

Record separately (with consent and without publishing personal content): commit SHA, device/browser, actual microphone/headset, voice provider/model, timestamps and connection failures. Start a real 30-minute project conversation. Include a negated task, a hypothetical completion, an explicit correction, an interruption during avatar loading, a denied proposal, an approved proposal and one unconfirmed proposal on exit. Check that only reviewed changes persist. Repeat on an actual later day with another avatar and confirm that deleted notes are absent. Then authorize a dedicated Google test account and verify one approved event in Calendar; verify the result appears in the app only after readback. Test popup denial, expired authorization and network loss using a test account.

A checked-in test suite or a successful CI run is not evidence that these human/live steps happened. Until those observations exist, report human 30-minute conversation and live Google acceptance as **NOT RUN**, not PASS.
