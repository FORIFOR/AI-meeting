# Zoom connection attempt — 2026-09-09

Release remains **NO_GO**. The user supplied a Zoom meeting URL; its ID and password are intentionally excluded from this report.

The first real cloud create request failed because Attendee defaults to the native Zoom SDK, which rejects voice-agent webpages and closed-caption transcription. The broker now explicitly selects `zoom_settings.sdk=web` for Zoom character and listener bots. Google Meet payloads remain covered by regression assertions. All 730 tests across 72 files and type checking passed.

The fix is deployed to Cloud Run revision `ai-meeting-broker-00012-xc9` with 100% traffic. The subsequent real create request passed that validation but failed with “Zoom App credentials are required to create a Zoom bot.” The authenticated Attendee Credentials page independently shows “Add OAuth App needed to launch Zoom Bots.” Zoom Marketplace is currently signed out.

No bots were created in either attempt. No admission, voice/video round trip, or 30-minute Zoom soak occurred, and no test bot needs leaving. Do not count these attempts toward the required real Zoom sessions.

Next: authenticate to Zoom Marketplace, configure the Meeting SDK app and register its credentials with Attendee, then retry real admission. External-meeting authorization may also be required; verify it for the actual account rather than assuming credentials alone are sufficient. Follow the [Attendee Zoom OAuth guide](https://docs.attendee.dev/guides/zoom/zoomoauth). Secrets must stay out of Git and chat.

Previous voice latency/interruption failures, repeated Meet/Zoom sessions, and the actual 15-person × 3-session evaluation remain open. This attempt does not change those gates.
