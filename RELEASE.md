# RELEASE — 0.2.0-beta.1 (Production Beta Candidate)

Policy: H0 (see `~/.claude/CLAUDE.md`). Stable release requires `Readiness=PASS` or an explicit user override. This document is the single source of truth for what this build is and what it is not.

## Readiness
- Automated gates: `node scripts/release/check.mjs --artifacts` (version consistency, CHANGELOG/RELEASE, secrets scan, typecheck, tests, build, licenses, artifact + signature checks).
- Reality gates: `docs/acceptance-gates.md` (Round 3 table). Local: PASS. Cloud/meeting: BLOCKED_BY_* (no credentials).
- Manual GUI smoke: **ManualSmoke=NOT_RUN_BY_ASSISTANT** — automated headless-Chrome runs only (no physical mic on the build machine).

## Artifacts
| Artifact | Path | Status |
|---|---|---|
| macOS app (Developer ID signed) | `apps/desktop/src-tauri/target/release/bundle/macos/Realtime Character AI.app` | built by `pnpm --filter @rcai/desktop exec tauri build` |
| macOS DMG | `apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg` | same |
| Notarization / stapling | — | **BLOCKED_BY_APPLE_NOTARY_CREDS** (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) |
| Auto-update (`latest.json`) | — | **BLOCKED_BY_UPDATE_ENDPOINT** (no updater endpoint/signing key; plugin not wired) |
| Web static build | `apps/web/dist/` | `pnpm build` |
| Services | `services/token-broker`, `services/agent` | run with `pnpm dev` / `scripts/local-stack.sh` (no container images yet) |
| Windows | — | **BLOCKED_BY_WINDOWS_BUILD_HOST** |

## Distribution scope of this beta
Internal / tester distribution only. The desktop app does not bundle the services: testers run `pnpm install && scripts/fetch-sample-character.sh && scripts/fetch-live2d-core.sh && scripts/local-stack.sh start && pnpm dev` (or `pnpm reality:human`) and then open the app. Sample characters are Live2D Free Material License (dev only) — replace before commercial release (`NOTICE.md`).

## Steps performed for this version
1. Version bump 0.1.0 → 0.2.0-beta.1 in package.json (root/web/desktop), tauri.conf.json, Cargo.toml.
2. `node scripts/release/check.mjs --artifacts` → see the report appended below.
3. `pnpm --filter @rcai/desktop exec tauri build` (app + dmg, signed).
4. Git: initial commit, `release/0.2.0-beta.1` branch, tag `v0.2.0-beta.1` (no remote configured → not pushed).

## Steps a human must do to reach a public stable release
1. Provide notarization credentials and run `pnpm --filter @rcai/desktop exec tauri build` again (Tauri notarizes + staples automatically), then `spctl --assess --type execute -vv "<app>"` must print `accepted`.
2. Decide the update channel (S3/GCS/GitHub Releases), configure `tauri-plugin-updater` + `latest.json` signing key, and re-run the check.
3. Run the credentialed Reality Gates: `pnpm reality:openai`, `pnpm reality:gemini`, `pnpm reality:meet`, and the 10-minute human gate on a machine with a microphone (`pnpm reality:human`).
4. Replace sample characters/voices with licensed assets; re-run `pnpm licenses:check`.
5. Push the release branch/tag to the remote and cut the GitHub release with `CHANGELOG.md`.

## Release check output (2026-08-30, `node scripts/release/check.mjs --artifacts`)
| item | status |
|---|---|
| version consistency (package.json ×3, tauri.conf.json, Cargo.toml = 0.2.0-beta.1) | PASS |
| CHANGELOG / RELEASE contain version | PASS |
| secrets / .env / incident media in shipped files | PASS (none) |
| typecheck · tests (34 files / 296) · web build · licenses | PASS |
| macOS .app exists · codesign --verify --deep --strict | PASS |
| Gatekeeper assessment | BLOCKED_BY_APPLE_NOTARY_CREDS (rejected — not notarized) |
| macOS .dmg (`Realtime Character AI_0.2.0-beta.1_aarch64.dmg`, signed) | PASS |
| updater latest.json | BLOCKED_BY_UPDATE_ENDPOINT |
| external credentials | BLOCKED_BY_OPENAI_KEY / GEMINI_KEY / RECALL_KEY / APPLE_NOTARY_CREDS |

**Readiness=PASS_WITH_BLOCKED** · ManualSmoke=NOT_RUN_BY_ASSISTANT (built app launched once headless-free: process ran, window rendered the offline-services guidance; no human click-through) · Distribution=NOT_PERFORMED (no remote, no channel).
