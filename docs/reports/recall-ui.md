# Recall meeting workflow — UI (Fork R3)

The user-facing half of the Recall integration: which meetings the character will attend, and the
record it leaves behind. Backend routes are implemented in parallel (Forks R1/R2); every screen
renders an honest empty/not-connected state when a route is absent, so nothing here fakes a
connected calendar or a transcript that does not exist.

## Screens

| Screen | Level | Content |
|---|---|---|
| 会議 (`Meetings.tsx`) | 1 | これからの予定 (calendar events, join/skip + reason), 進行中, 終わった会議, and a quiet 「URL を入れて今すぐ参加」 link at the bottom — the URL flow is kept as the test/admin surface the onboarding guide asks for, not the default UX. |
| 参加する条件 (inside 会議, `<details>`) | 2 | The opt-in rule: 合図語 (markers, default `#yui`) and 何分前に入るか (lead minutes), saved through `PUT /api/calendar/rule`. |
| 会議の記録 (`MeetingDetail.tsx`) | 1 | The persisted output: status line, one plain failure sentence when the bot or the transcript failed, and the transcript as grouped dialogue with a 全文をコピー button. |

Home's meeting action now opens 会議 (was: straight to the URL form).

## Rules honoured

- **No raw codes in the flow.** `reasonJa()` and `statusJa()` turn backend codes into sentences
  (「タイトルに #yui がありません」「過去の予定です」「会議リンクがありません」…); the original code stays in a
  `title` attribute. An unknown future code degrades to 「この予定は対象外です」 rather than leaking the string.
- **Opt-in is explicit.** An event is joined only when the marker rule matches or the user pressed
  参加させる; the row always states which. Events without a meeting link cannot be opted in.
- **Design system.** Only existing classes (`.page`, `.rows`, `.row`, `.group`, `.disc`, `.chip`,
  `.empty`, `.notice`, `.err`, `.hint`) plus one new `.dialogue` block; every value is an `--app-*`
  token, nothing below 14px, blue only on primary/selected/link.
- **States.** loading / empty / error / not-connected exist on both screens, all in Japanese.

## Files

- `apps/web/src/api/meetings.ts` — REST client (`meetingsApi`) + pure helpers: `reasonJa`,
  `statusJa`, `failureSentence`, `isFinished`, `splitEvents`, `sortMeetings`, `groupUtterances`,
  `blocksToText`, `clockLabel`, `timeLabel`, `DEFAULT_RULE`.
- `apps/web/src/api/meetings.test.ts` — 12 tests.
- `apps/web/src/screens/Meetings.tsx`, `apps/web/src/screens/MeetingDetail.tsx` — new screens.
- `apps/web/src/App.tsx` — `meetings` / `meetingDetail` routes; Meeting's back goes to 会議.
- `apps/web/src/screens/Home.tsx` — the action reads 会議 · Google Meet · Zoom に同席.
- `apps/web/src/styles/global.css` — `.dialogue*` only.

## Commands and results

```
pnpm vitest run apps/web/src/api/meetings.test.ts   → 12 passed
pnpm --filter @rcai/web typecheck                    → clean
pnpm --filter @rcai/web build                        → ✓ built in 4.51s
pnpm vitest run apps/web                             → 5 files / 23 tests passed
```

Tests cover the reason→Japanese mapping (including the unknown-code fallback), lifecycle status and
failure sentences, upcoming-ascending / past-descending splitting (an in-progress event counts as
upcoming), meeting sorting, and the utterance→dialogue grouping for both the `utterances` and
`words` payload shapes.

## Not verified here

- No browser run (the parent owns the browser) and no live backend: the screens were exercised only
  through unit tests and the type/build boundary.
- Route shapes come from the agreed contract; if R1/R2 rename a field, `apps/web/src/api/meetings.ts`
  is the single file to adjust.
- `GET /api/meetings/:id/transcript` is assumed to return `{ utterances | words, text }`; the
  grouping helper accepts either and ignores empty items.
