# Private inquiries and site measurement

The marketing page sends inquiries to `POST /api/site/leads`. It never creates a public GitHub issue. Only service-account/IAM access can read the Firestore collection; no public read endpoint exists. The operator can read the inbox using application-default credentials:

```sh
GOOGLE_CLOUD_PROJECT=your-project RCAI_HOSTED_FIRESTORE_DATABASE=your-database pnpm exec tsx scripts/business/site-inbox.mts
```

Use `--details` to display submitted contact information and messages for follow-up. Default output omits these fields. No automatic email is sent. A form submission does not create a contract or payment.

Set `RCAI_MARKETING_ORIGIN` to the exact public Site origin to enable intake. The broker also needs its configured Google Cloud project and server-only Firestore database. The local Site preview origin `http://127.0.0.1:5196` is allowed for browser validation. JSON bodies are capped at 8 KB by reading actual streamed bytes. Validation checks required fields, consent, the honeypot, and length bounds. There are no uploads.

Reservations are atomic, with a global limit of 100 accepted inquiries per UTC day and 3 per reply email per day. Retry with the same request UUID and identical content returns the original receipt without another record. Changed content under the same UUID is rejected. Unavailable/corrupt storage fails closed; the UI retains entered fields and never reports success before durable acceptance. These safeguards limit abuse but do not establish that spam cannot occur.

Collections `ai_meeting_site_leads`, `ai_meeting_site_lead_usage`, and `ai_meeting_site_events` have an `expiresAt` field set to 90 days after creation/update. Enable Firestore TTL on that field for all three collection groups. TTL deletion is asynchronous after eligibility, not a promise of deletion at the exact second. Inquiry messages and contact information are used for inquiry follow-up, not AI model input or analytics.

`POST /api/site/events` accepts only allowlisted event names, scenarios and languages. It rejects free-text fields, contact details, arbitrary URLs and visitor identifiers. Counters are aggregated by UTC day, with a 20,000-event daily cap. The frontend respects Do Not Track and Global Privacy Control and uses no analytics cookies. `demo_complete` means the recorded sample reached its end, including through seeking; it does not prove attentive listening. Events are not deduplicated into unique visitors. Infrastructure may retain ordinary access logs independently; the application stores no IP address in these event aggregates.

`lead_submit` is derived from successfully persisted inquiry records, not a client-supplied event. `github_outbound` measures clicks and must never be reported as GitHub stars. Marketing-site events are separate from app telemetry and contain no audio, conversation, task or form content.

## Validation on September 13, 2026

Seven targeted tests cover input/privacy validation, origin and size limits, durable-store failure, idempotent retries, concurrency and aggregate counters. The broker typecheck and 39 related intake/access tests pass. A deployed test inquiry returned 201 only after Firestore persistence; retry returned the same receipt. Foreign origins returned 403, public GET returned 405, and an unauthenticated Firestore read returned 403. All three TTL policies were ACTIVE. A separate headless browser submitted the actual form, displayed its receipt and cleared its inputs after persistence. The synthetic records were deleted; reservation counters were retained. See [sanitized evidence](validation-assets/site-intake.json).

## Portfolio extension
The same private inbox now accepts fixed useCase values genie, launchloom, oathra, aisecure and agent-team. Allowed marketing origins additionally include https://astra-forifor.forifor.chatgpt.site and https://forifor.github.io, only on /api/site/. No product API CORS, public read or authentication permission is added. Existing global/email caps and TTL remain in force. Event scenarios use the same fixed product IDs, not visitor text. Five production synthetic inquiries verified CORS, durable storage, idempotency and denied public reads, then were deleted. No email was sent.
