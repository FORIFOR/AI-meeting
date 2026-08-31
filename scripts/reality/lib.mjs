/** Shared helpers for the one-command Reality Gates (`pnpm reality:*`). Never fakes a PASS. */
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(new URL("../..", import.meta.url).pathname);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Merge process.env with services/token-broker/.env (keys never printed). */
export function loadEnv() {
  const out = { ...process.env };
  const p = resolve(ROOT, "services/token-broker/.env");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!out[m[1]]) out[m[1]] = v;
    }
  }
  return out;
}

/** Exit with a BLOCKED_BY_* code (2) unless every required key is present. */
export function requireKeys(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    for (const k of missing) console.log(`BLOCKED_BY_${k.replace(/_API_KEY$/, "_KEY")}: ${k} is not set (services/token-broker/.env or environment)`);
    process.exit(2);
  }
}

export async function waitHttp(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(500);
  }
  return false;
}

const children = [];
export function start(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.env.REALITY_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.env.REALITY_VERBOSE && process.stderr.write(`[${name}] ${d}`));
  children.push({ name, child });
  return child;
}
export function stopAll() {
  for (const { child } of children.reverse()) { try { child.kill("SIGTERM"); } catch {} }
}
process.on("exit", stopAll);
process.on("SIGINT", () => { stopAll(); process.exit(130); });

function portFree(port) {
  try { execSync(`lsof -ti:${port}`, { stdio: "pipe" }); return false; } catch { return true; }
}

/**
 * Starts broker (8787), optionally the local stack + agent (8788), and a web server.
 * An already-running dev server on 5173 is reused (that is what a tunnel usually points at);
 * otherwise the app is built and previewed on 5180.
 */
export async function startStack({ local = false, env = {} } = {}) {
  const devUp = !portFree(5173);
  if (local) {
    execSync("scripts/local-stack.sh start", { cwd: ROOT, stdio: "inherit" });
    if (portFree(8788)) start("agent", "pnpm", ["--filter", "@rcai/agent", "start"], { RCAI_EGRESS_LOG: "1", ...env });
  }
  if (portFree(8787)) start("broker", "pnpm", ["--filter", "@rcai/token-broker", "start"], env);
  const webPort = devUp ? 5173 : 5180;
  if (!devUp && portFree(5180)) {
    execSync("pnpm --filter @rcai/web build", { cwd: ROOT, stdio: "inherit" });
    start("web", "pnpm", ["--filter", "@rcai/web", "exec", "vite", "preview", "--port", "5180", "--strictPort"], env);
  }
  const ok = (await waitHttp("http://localhost:8787/health")) && (await waitHttp(`http://localhost:${webPort}/`)) && (!local || (await waitHttp("http://127.0.0.1:8788/health")));
  if (!ok) { console.log("FAIL: stack did not become healthy"); process.exit(1); }
  return `http://localhost:${webPort}`;
}

export function run(cmd, args, env = {}) {
  return new Promise((res) => {
    const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
    c.on("exit", (code) => res(code ?? 1));
  });
}
