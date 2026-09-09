# Simple conversation settings — 2026-09-09

Home now asks for a character and a purpose, then Setup offers a voice. Meeting offers the same three choices and folds optional controls away. English lesson labels and levels use Japanese labels while retaining provider identifiers.

Hosted Attendee receives character, persona, voice, engine and page-audio settings from the operator. Broker health exposes Hosted availability, so the public join form no longer requires a Recall key. Unconfigured realistic characters are disabled. Setup uses live provider availability when choosing its voice list.

## Verification

Web typecheck and production build passed. 44 targeted tests passed, including selected character/purpose/voice forwarding into the meeting controller and through Attendee creation. Local browser inspection covered Home, English Setup and Meeting. Public HTML matches the local build. No new live bot was created for this UI change; prior live meeting evidence is separate.

## Credit display

`apps/web/public/meeting-credit-balance.json` is a manually confirmed shared meeting balance. 4.07 credits was read from the authenticated Attendee billing dashboard at 2026-09-09 12:30 JST. It is not a personal wallet or a live API balance. The UI labels the previous confirmation time and links to the billing dashboard, which requires account access. AI conversation charges are separate. To refresh, confirm the dashboard and update both credits and checkedAt before deploying. Do not substitute zero when the balance is unavailable.

This change does not establish Release=GO or replace outstanding human and Zoom evaluations.
