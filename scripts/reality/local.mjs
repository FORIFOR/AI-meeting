/** pnpm reality:local — 10-minute fully local soak (strict_local) + latency breakdown; the only gate runnable without credentials. */
import { startStack, run, stopAll } from "./lib.mjs";
const minutes = process.argv[2] ?? "10";
const base = await startStack({ local: true });
const code = await run("node", ["apps/web/scripts/soak-browser.mjs", "--engine", "local", "--minutes", minutes, "--base", base, "--mode", "free_talk"]);
const egress = await (await fetch("http://127.0.0.1:8788/egress")).json();
console.log("strict_local egress entries:", JSON.stringify(egress.entries ?? egress));
stopAll();
process.exit(code || ((egress.entries ?? []).length ? 1 : 0));
