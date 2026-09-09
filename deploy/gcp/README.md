# Google Cloud deployment

This directory contains the production deployment contract for the split architecture:

```text
Browser ──> static web hosting
   │
   ├── direct mode ──> Cloud Run WebSocket relay → Vertex AI Live (ADC)
   │
   └── meeting mode ──> Cloud Run API ──> Attendee Hosted or GKE Attendee
                                      └─> agent/runtime
```

The default rollout uses Cloud Run for the broker and Attendee Hosted for meeting transport. GKE,
Cloud SQL, Memorystore, and recording storage are optional until measured usage justifies their fixed
cost. The GKE contract is documented in `gke/README.md`; it is not safe to apply without an Attendee
self-host image and a completed Meet/Zoom admission test.

## Prerequisites

- A Google Cloud project with billing enabled.
- `gcloud` authenticated with permission to enable APIs, push to Artifact Registry, deploy Cloud Run,
  and access Secret Manager.
- A dedicated Attendee Hosted API key and webhook secret, or an approved Attendee self-host deployment.
- A public HTTPS hostname for the web application and broker. Do not use localhost or a temporary tunnel
  in production.

The project and secrets are intentionally supplied at deploy time. No credential is committed to this
repository.

## Preflight

```sh
PROJECT_ID=your-project-id REGION=asia-northeast1 pnpm cloud:gcp:preflight
```

The preflight is read-only. It checks authentication, billing, and required APIs. It does not create
resources or send meeting traffic.

## Deploy the broker

```sh
PROJECT_ID=your-project-id \
REGION=asia-northeast1 \
BROKER_PUBLIC_URL=https://api.ai-meeting.example.com \
WEB_PUBLIC_URL=https://app.ai-meeting.example.com \
pnpm cloud:gcp:deploy:broker
```

The script builds `deploy/cloud/Dockerfile.broker`, stores secrets in Secret Manager, and deploys a
single Cloud Run instance. It uses `min-instances=0` for the beta cost gate. Set `MAX_INSTANCES=1`
until session state is moved to a durable store.

The default Vertex AI deployment requires `MEETING_TOKEN_SECRET`, `PROJECT_ID`, the enabled
`aiplatform.googleapis.com` API, and `roles/aiplatform.user` on the Cloud Run runtime service account.
It uses ADC; no AI Studio API key or prepaid balance is needed. `GOOGLE_CLOUD_LOCATION` defaults to
`us-central1`, and `VERTEX_LIVE_MODEL` defaults to `gemini-live-2.5-flash-native-audio`.
Set `GEMINI_BACKEND=developer` with `GEMINI_API_KEY` only to opt back into the Developer API.
Keep `MAX_INSTANCES=1`: relay ticket replay tracking and meeting state are instance-local.
The relay tickets expire after two minutes; each reconnect obtains a new ticket.
Cloud Run WebSocket requests use a 3600-second timeout. Add
`HOSTED_ATTENDEE_API_KEY`, `HOSTED_ATTENDEE_WEBHOOK_SECRET`, `BROKER_PUBLIC_URL`, and `WEB_PUBLIC_URL` when the
meeting transport is ready. Use credentials issued by app.attendee.dev, not the local Attendee server.
The script checks Hosted authentication before changing cloud resources and stores the key in a
dedicated Hosted secret. Authentication success does not prove sufficient credits or Meet admission.
The script never prints secret values.

## Static web hosting

```sh
VITE_RCAI_CLOUD=true \
VITE_RCAI_BROKER_URL=https://api.ai-meeting.example.com \
pnpm --filter @rcai/web build
```

Serve `apps/web/dist` with Firebase Hosting or Cloudflare Pages. Configure the broker CORS policy to
the exact web origin before public release.

## Rollout order

1. Deploy the broker and verify `/health` and `/api/token/gemini` and a real Vertex AI WebSocket handshake.
2. Publish the web artifact and verify direct 1:1 mode; this path does not consume Attendee time.
3. Configure Attendee Hosted and run the 5-minute and 30-minute Google Meet Reality Gates.
4. Verify the same `/agent/runtime` page in Attendee's voice-agent browser.
5. Only after measured bot-hour cost and concurrency require it, deploy the isolated GKE bot pool.

The release remains blocked until real Meet/Zoom runs, long-session stability, and human evaluation
are recorded in the existing commercial gate.
