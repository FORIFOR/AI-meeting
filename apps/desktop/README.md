# apps/desktop — Tauri 2 shell

Hosts `apps/web` in a native window. No native AI/avatar code lives here (all vendor SDKs stay behind `@rcai/*` contracts in the web bundle). Run local services with `pnpm dev` in the repo root, then `pnpm --filter @rcai/desktop dev`.
`cargo check` status is recorded in `docs/acceptance-gates.md`.
