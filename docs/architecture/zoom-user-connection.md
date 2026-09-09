# Zoom account connection

Implemented in source `e4dd874`, hardened through `45755f5` and UI `872a13c` (2026-09-09); production review and external-account verification are still required. Development credentials alone do not establish general availability.

## User flow

1. In the meeting screen, choose **Zoomと連携**.
2. Authorize on Zoom and return to the same tab. The account that authorized is the application identity for this integration.
3. The screen displays **Zoom 連携済み**. Paste a meeting URL and invite Yui.
4. **Zoomの連携を解除** blocks new joins locally and deletes the caller's Attendee OAuth connection. Failed remote deletion remains retryable and is shown as pending, not as a successful disconnect.

## Boundaries and persistence

- The browser generates a 256-bit verifier, retains it in sessionStorage, and sends only its SHA-256 challenge when navigating to the broker.
- The broker generates random OAuth state and a separate Secure, HttpOnly, SameSite=Lax host-only cookie. The callback must match both state and cookie. State is atomically consumed before exchanging a code with Attendee.
- Completion must present the browser verifier and the expected web Origin. A concurrent or repeated callback/completion, invalid state, missing cookie, wrong verifier, rejection or expiration cannot issue another application session.
- Application identity comes only from Attendee's returned Zoom user ID. Browser-supplied Zoom IDs and zoom_settings are ignored. The server supplies `zoom_settings.onbehalf_token.zoom_oauth_connection_user_id` after authorization.
- Firestore database `ai-meeting-zoom` in `asia-northeast1` stores connection references, account identifiers and hashed session tokens. The browser receives an opaque application session, never Attendee/Zoom provider credentials. Firestore access uses the broker service account; the web app has no Firestore client access.
- OAuth flows expire after 10 minutes and application sessions after 12 hours. Server-side checks enforce expiration regardless of asynchronous Firestore TTL cleanup.
- Each join checks the actual Attendee connection state and user identity, failing closed if the provider is unavailable, revoked or mismatched. A disconnect invalidates future joins. It does not claim to remove bots already admitted through other sessions.
- Configuring Zoom OAuth enables authentication for Zoom bot creation. With incomplete configuration, `ZOOM_REQUIRE_AUTH=1` fails closed. Meet behavior retains its existing path.

## Deployment configuration

`ZOOM_OAUTH_CLIENT_ID`, `ZOOM_OAUTH_CALLBACK_URL`, `ZOOM_OAUTH_WEB_ORIGIN`, `ZOOM_FIRESTORE_DATABASE`, `GOOGLE_CLOUD_PROJECT`, and existing `ATTENDEE_API_KEY` configure the integration. `ZOOM_REQUIRE_AUTH=1` protects partial deployments. Only fixed HTTPS origins are accepted.

Development callback: `https://ai-meeting-broker-pdygkns5gq-an.a.run.app/api/zoom/callback`. Zoom strict redirect matching is enabled. Required on-behalf scopes are `user:read:user` and `user:read:token`; the existing SDK `user:read:zak` scope remains.

The full test suite passed 746 tests / 74 files, including account isolation, callback/complete races, tampering, expiration, denial, provider revocation, retryable disconnect, frontend callback deduplication, token scoping and server-derived join identity. Follow-up targeted checks cover pending disconnect status and callback error handling.

Deployed to Cloud Run revision `ai-meeting-broker-00015-6k4` and Firebase Hosting `f6b5c3bd7d3ad65a`. Actual browser authorization, one-click disconnect, and reconnect passed on this deployment. Durable connection state also survived the preceding Cloud Run revision change. Application sessions are bound to the specific provider grant: a superseded session cannot use or disconnect a fresh authorization.

Still required: perform external-account meeting trials; complete Zoom production configuration/review with genuine operator, support and policy details; run release performance and human-study gates. None of these are implied by unit tests.

References: [Attendee OAuth guide](https://docs.attendee.dev/guides/zoom/zoomoauth), [Zoom authorization FAQ](https://developers.zoom.us/docs/meeting-sdk/obf-faq/), [Firestore transactions](https://docs.cloud.google.com/firestore/native/docs/manage-data/transactions).
