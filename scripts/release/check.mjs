#!/usr/bin/env node
/**
 * Release readiness check (H0 policy): fails hard on automated gates, reports BLOCKED_BY_* for external dependencies.
 * Usage: node scripts/release/check.mjs [--skip-gate] [--artifacts]
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const args = new Set(process.argv.slice(2));
const rows = [];
const row = (item, status, detail = "") => rows.push({ item, status, detail });
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const version = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;

// 1. Version consistency
const versions = {
  "package.json": JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version,
  "apps/web/package.json": JSON.parse(readFileSync(resolve(ROOT, "apps/web/package.json"), "utf8")).version,
  "apps/desktop/package.json": JSON.parse(readFileSync(resolve(ROOT, "apps/desktop/package.json"), "utf8")).version,
  "tauri.conf.json": JSON.parse(readFileSync(resolve(ROOT, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")).version,
  "Cargo.toml": /^version = "(.*)"$/m.exec(readFileSync(resolve(ROOT, "apps/desktop/src-tauri/Cargo.toml"), "utf8"))?.[1],
};
const consistent = Object.values(versions).every((v) => v === version);
row("version consistency", consistent ? "PASS" : "FAIL", `${version} · ${Object.entries(versions).filter(([, v]) => v !== version).map(([k, v]) => `${k}=${v}`).join(", ") || "all equal"}`);
row("CHANGELOG has this version", readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8").includes(`## [${version}]`) ? "PASS" : "FAIL");
row("RELEASE.md has this version", readFileSync(resolve(ROOT, "RELEASE.md"), "utf8").includes(version) ? "PASS" : "FAIL");

// 2. Git state
let dirty = "";
try { dirty = sh("git status --porcelain"); } catch { dirty = "(not a git repo)"; }
row("git working tree clean", dirty === "" ? "PASS" : "WARN", dirty === "" ? "" : `${dirty.split("\n").length} changed/untracked paths`);
try { row("git tag v" + version, sh(`git tag -l v${version}`) ? "PASS" : "WARN", "tag created at release time"); } catch {}

// 3. Secrets / private data that must never ship
const tracked = (() => { try { return sh("git ls-files --cached --others --exclude-standard").split("\n"); } catch { return []; } })().filter((f) => !f.startsWith("reference/") && !f.startsWith("node_modules/"));
const secretRe = /sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN (RSA |EC )?PRIVATE KEY|ghp_[A-Za-z0-9]{30,}/;
const leaks = [];
for (const f of tracked) {
  if (!existsSync(resolve(ROOT, f)) || statSync(resolve(ROOT, f)).size > 2_000_000) continue;
  if (/\.(png|jpg|wav|mp3|gguf|onnx|moc3|bin)$/.test(f)) continue;
  try { if (secretRe.test(readFileSync(resolve(ROOT, f), "utf8"))) leaks.push(f); } catch {}
}
row("no secrets in shipped files", leaks.length ? "FAIL" : "PASS", leaks.join(", "));
row("no .env / incident media in shipped files", tracked.some((f) => /(^|\/)\.env$|\.env\.[a-z]+$|incidents\/.*\.(wav|jpg)$|\.jsonl$/.test(f) && !f.endsWith(".env.example")) ? "FAIL" : "PASS");

// 4. Automated gates
if (!args.has("--skip-gate")) {
  for (const [name, cmd] of [["typecheck", "pnpm -r typecheck"], ["tests", "pnpm test"], ["web build", "pnpm build"], ["licenses", "pnpm licenses:check"]]) {
    try { sh(cmd); row(name, "PASS"); } catch (e) { row(name, "FAIL", String(e.stderr ?? e.message).slice(-300)); }
  }
}

// 5. Artifacts
if (args.has("--artifacts")) {
  const app = resolve(ROOT, "apps/desktop/src-tauri/target/release/bundle/macos/Realtime Character AI.app");
  const dmgDir = resolve(ROOT, "apps/desktop/src-tauri/target/release/bundle/dmg");
  row("macOS .app exists", existsSync(app) ? "PASS" : "FAIL", app);
  if (existsSync(app)) {
    try { sh(`codesign --verify --deep --strict "${app}"`); row("codesign verify", "PASS"); } catch { row("codesign verify", "FAIL"); }
    try { const out = sh(`spctl --assess --type execute -vv "${app}" 2>&1 || true`); row("Gatekeeper (notarized)", /accepted/.test(out) ? "PASS" : "BLOCKED_BY_APPLE_NOTARY_CREDS", out.split("\n")[0]); } catch { row("Gatekeeper (notarized)", "BLOCKED_BY_APPLE_NOTARY_CREDS"); }
  }
  let dmg = null;
  try { dmg = sh(`ls -1 "${dmgDir}"/*.dmg 2>/dev/null | head -1`); } catch {}
  row("macOS .dmg exists", dmg ? "PASS" : "FAIL", dmg ?? "");
  row("updater latest.json", "BLOCKED_BY_UPDATE_ENDPOINT", "no update endpoint / signing key configured");
  row("web dist", existsSync(resolve(ROOT, "apps/web/dist/index.html")) ? "PASS" : "FAIL");
}

// 6. External dependencies (informational)
for (const k of ["OPENAI_API_KEY", "GEMINI_API_KEY", "RECALL_API_KEY", "APPLE_ID"]) row(`external: ${k}`, process.env[k] ? "PASS" : `BLOCKED_BY_${k.replace(/_API_KEY$/, "_KEY").replace("APPLE_ID", "APPLE_NOTARY_CREDS")}`);

const fail = rows.filter((r) => r.status === "FAIL");
const blocked = rows.filter((r) => r.status.startsWith("BLOCKED"));
console.log(`# Release check ${version}\n\n| item | status | detail |\n|---|---|---|`);
for (const r of rows) console.log(`| ${r.item} | ${r.status} | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
console.log(`\nReadiness=${fail.length ? "FAIL" : blocked.length ? "PASS_WITH_BLOCKED" : "PASS"} · blocked=${blocked.map((b) => b.status).join(",") || "none"}`);
process.exit(fail.length ? 1 : 0);
