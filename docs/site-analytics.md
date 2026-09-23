# Public-site event measurements

The marketing site sends anonymous `{event, scenario, language}` records to
`POST /api/site/events`. The broker accepts only the event names in
`SITE_EVENTS`, known scenarios, and `ja` or `en`. Unexpected fields and foreign
origins are rejected. Existing privacy choices and daily limits still apply.

`business_open` counts clicks on links to the business section, separately for each
scenario and language. It does **not** mean an inquiry was submitted, a meeting
was booked, or a customer was acquired. It stores only a daily UTC counter;
contact details remain exclusive to the separate private inquiry route.

Before the September 23, 2026 correction, the homepage already emitted
`business_open`, but the broker's event allowlist rejected it. Missing historical
counts cannot establish that nobody clicked the business links, and those
rejected events cannot be recovered from these aggregates.

The default operator check is `scripts/business/site-inbox.mts`. Its lead query
is bounded to 30 recent records and excludes expired records. Its event query
returns at most seven documents before sorting them locally; it is not a
guaranteed complete rolling seven-day report. Missing days or scenario keys
must not be reported as zero visitors or zero product users.

`demo_start` and `demo_complete` measure recorded media events, not completion
of a live product task. Aggregate counters do not identify unique people,
exclude internal checks, or attribute a GitHub star to a particular post.

Regression checks:

```sh
pnpm exec vitest run services/token-broker/src/site-intake.test.ts services/token-broker/src/site-intake.reachmade.test.ts
pnpm --filter @rcai/token-broker typecheck
```

These tests use a fake store/Firestore transaction implementation. They cover
both languages, anonymous daily persistence, separation from private leads,
and rejection of contact fields or foreign origins without sending test
events to production analytics.
