# Acceptance gates

See [the public validation summary](validation.md) for the measured scope and unverified product gates. The avatar checks are PASS_AUTOMATED_ONLY; human-perceived quality and other-participant Meet/Zoom output are not a completed commercial gate.

Run `pnpm typecheck`, `pnpm test`, and `pnpm build:oss` for the source checks. Realtime AI and meeting tests need the corresponding runtime, keys and an actual call. A missing dependency or credential is a blocked test, never a pass.
