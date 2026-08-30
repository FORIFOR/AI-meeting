/** pnpm reality:human — starts the full local stack and opens the app for the 10-minute Human Reality Gate. */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { startStack, ROOT, sleep } from "./lib.mjs";
const base = await startStack({ local: true });
console.log("\n" + readFileSync(`${ROOT}/docs/human-gate.md`, "utf8").split("\n").slice(0, 40).join("\n"));
console.log(`\nOpen ${base} — in the session menu enable 「評価パネル · Human gate」. Observations go to docs/reports/human/. Press Ctrl-C to stop the stack.`);
try { execSync(`open ${base}`); } catch {}
for (;;) await sleep(60_000);
