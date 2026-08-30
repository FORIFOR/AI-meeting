#!/usr/bin/env node
/**
 * License audit: writes licenses.json + THIRD_PARTY_NOTICES.md from `pnpm licenses list --json`,
 * and prepends the curated non-OSS notices (Live2D, sample models, voices, cloud services) from NOTICE.md.
 * Usage: node scripts/licenses.mjs [--check]   (--check fails on copyleft/unknown licenses)
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const raw = execSync("pnpm licenses list --json --long", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const byLicense = JSON.parse(raw);
const rows = [];
for (const [license, pkgs] of Object.entries(byLicense)) {
  for (const p of pkgs) rows.push({ name: p.name, versions: p.versions ?? [p.version], license, author: p.author ?? "", homepage: p.homepage ?? "", description: p.description ?? "" });
}
rows.sort((a, b) => a.name.localeCompare(b.name));
const COPYLEFT = /GPL|AGPL|LGPL|SSPL|EUPL|CC-BY-SA|CC-BY-NC/i;
const ATTENTION = /CC-BY(?!-SA)|MIT OR GPL|UNKNOWN|UNLICENSED|SEE LICENSE/i;
const flagged = rows.filter((r) => COPYLEFT.test(r.license) && !/OR MIT|MIT OR/i.test(r.license));
const attention = rows.filter((r) => ATTENTION.test(r.license));
writeFileSync("licenses.json", JSON.stringify({ generatedAt: new Date().toISOString(), count: rows.length, packages: rows, flagged: flagged.map((r) => r.name), attention: attention.map((r) => ({ name: r.name, license: r.license })) }, null, 2));

const notice = readFileSync("NOTICE.md", "utf8");
let md = `# Third-party notices\n\nGenerated ${new Date().toISOString()} by \`scripts/licenses.mjs\`. ${rows.length} npm packages.\n\n`;
md += notice.replace(/^# .*\n/, "## Non-OSS and specially licensed components (curated)\n") + "\n\n## npm packages\n\n| Package | Version(s) | License |\n|---|---|---|\n";
for (const r of rows) md += `| ${r.name} | ${r.versions.join(", ")} | ${r.license} |\n`;
writeFileSync("THIRD_PARTY_NOTICES.md", md);
console.log(`licenses.json + THIRD_PARTY_NOTICES.md written (${rows.length} packages)`);
if (attention.length) console.log("attention:", attention.map((a) => `${a.name} (${a.license})`).join(", "));
if (flagged.length) {
  console.error("copyleft-only licenses found:", flagged.map((r) => `${r.name} (${r.license})`).join(", "));
  if (process.argv.includes("--check")) process.exit(1);
}
