/** pnpm reality:meet | reality:zoom — real meeting participation through Recall (Output Media bot page). */
import { loadEnv, requireKeys, startStack, run, stopAll } from "./lib.mjs";
const platform = process.argv[2]; // meet | zoom
const env = loadEnv();
requireKeys(env, ["RECALL_API_KEY", "RECALL_PUBLIC_URL", "RECALL_BOT_PAGE_URL"]);
const urlKey = platform === "zoom" ? "ZOOM_URL" : "MEET_URL";
if (!env[urlKey]) { console.log(`BLOCKED_BY_${urlKey}: set ${urlKey} to a live ${platform === "zoom" ? "Zoom" : "Google Meet"} link`); process.exit(2); }
if (!/^https:\/\/(meet\.google\.com|[a-z0-9.-]*zoom\.us)\//.test(env[urlKey])) { console.log(`FAIL: ${urlKey} is not a ${platform} URL`); process.exit(1); }
await startStack({ local: env.MEETING_ENGINE === "local", env });
const code = await run("pnpm", ["--filter", "@rcai/connector-recall", "e2e:meet"], { MEET_URL: env[urlKey], MODE: env.MODE ?? "output_media", BROKER_URL: "http://localhost:8787", ...env });
stopAll();
process.exit(code);
