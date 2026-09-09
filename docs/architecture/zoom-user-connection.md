# Zoom connection for general users

Status: implementation requirements, not a shipped OAuth flow (2026-09-09).

The development app `AI Meeting Yui` has Meeting SDK and programmatic join enabled. Its development credentials were registered with the Hosted Attendee project after user authorization. This permits an actual account-specific connection test; it is not Zoom approval for general distribution.

## Intended user flow

1. Select “Zoomと連携” in AI Meeting and authorize the app on Zoom.
2. Return to AI Meeting with a clear connected status.
3. Paste a meeting URL and invite Yui.
4. Show waiting-room, permission, connection and ended states; allow disconnecting Zoom.

Users do not supply SDK keys. Meeting owners and organization administrators retain their normal admission controls.

## Required implementation before general release

- Add a durable authenticated account boundary. Current meeting capability tokens authorize one meeting session, not ownership of a user's Zoom connection.
- Start OAuth with short-lived, single-use state bound to the authenticated user and browser session; reject mismatched, expired and replayed callbacks.
- Exchange the authorization code through Attendee's Zoom OAuth connection API. Persist the connection reference and Zoom user ID under the correct application user; never expose provider secrets or another user's connection.
- Set a fixed HTTPS callback in Zoom's allowed redirects, enforce strict redirect matching, and never accept arbitrary return URLs.
- Obtain the required user-authorized scopes and pass the linked user's identifier in `zoom_settings.onbehalf_token.zoom_oauth_connection_user_id` when joining external meetings. Never accept an arbitrary Zoom user ID supplied by the browser.
- Handle authorization rejection, revocation, disconnect and Attendee connection-state webhooks with verified authenticity. Delete/disconnect only the caller's connection and block new joins on revoked credentials.
- Add tests for user isolation, callback replay, tampered state, expired state, revocation and external-meeting denial; then test the real OAuth and external-account meeting path.
- Complete Zoom production review/approval and deploy the approved configuration. Development credentials and a same-account test must not be presented as general availability.

References: [Attendee OAuth guide](https://docs.attendee.dev/guides/zoom/zoomoauth), [Zoom authorization FAQ](https://developers.zoom.us/docs/meeting-sdk/obf-faq/).
