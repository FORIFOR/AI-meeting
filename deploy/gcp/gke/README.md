# GKE Attendee contract

GKE is the later-stage self-hosted Attendee target. It is intentionally not included in the first
Cloud Run rollout: the Attendee image, virtual audio/video device requirements, and hosting conditions
must be confirmed before creating a cluster.

When approved, use `LAUNCH_BOT_METHOD=kubernetes` and enforce one bot per isolated Pod. Never place
multiple active meeting bots in one shared Celery worker. The pod must have a dedicated Chromium/Xvfb/
audio device namespace and a bounded lifetime tied to the meeting session.

Before applying a deployment, record peak RSS and CPU per bot, admission success for Meet/Zoom/Teams,
audio round-trip latency, clean leave rate, orphan-pod rate, and cost per bot-hour. The GKE migration
gate passes only when measured self-host cost, including Cloud SQL, Memorystore, logging, and cluster
management, is lower than Attendee Hosted at the observed volume.
