/** pnpm reality:openai | reality:gemini — 30-minute real-API soak on the built web app. */
import { loadEnv, requireKeys, startStack, run, stopAll } from "./lib.mjs";
const engine = process.argv[2]; // openai | google
const minutes = process.argv[3] ?? "30";
const env = loadEnv();
requireKeys(env, [engine === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"]);
const base = await startStack({ env });
const health = await (await fetch("http://localhost:8787/health")).json();
if (!health.providers?.[engine]) { console.log(`BLOCKED_BY_${engine === "openai" ? "OPENAI" : "GEMINI"}_KEY: broker reports provider unavailable`); stopAll(); process.exit(2); }
const code = await run("node", ["apps/web/scripts/soak-browser.mjs", "--engine", engine, "--minutes", minutes, "--base", base, "--mode", "free_talk"]);
stopAll();
process.exit(code);
