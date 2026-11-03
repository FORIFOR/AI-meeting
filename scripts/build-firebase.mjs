import { spawnSync } from "node:child_process";

// Firebase Hosting serves a static bundle. Vite must embed the production
// broker at build time; otherwise a fresh browser points at its own localhost.
const broker = "https://ai-meeting-broker-pdygkns5gq-an.a.run.app";
const result = spawnSync("pnpm", ["build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_RCAI_CLOUD: "true",
    VITE_RCAI_OSS: "false",
    VITE_RCAI_RELEASE_CHANNEL: "beta",
    VITE_RCAI_BROKER_URL: broker,
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
