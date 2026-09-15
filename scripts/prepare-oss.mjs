import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Dedicated allowlist: never copy the regular public/ symlinks (Core, sample Live2D,
// derived portraits, operational credit data, local model/server assets).
const output = path.join(repo, "apps/web/public-oss");
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "characters"), { recursive: true });
for (const id of ["vroid-b", "vrm-sample"]) await cp(path.join(repo, "characters", id), path.join(output, "characters", id), { recursive: true });
await cp(path.join(repo, "apps/web/public/demo"), path.join(output, "demo"), { recursive: true });
await cp(path.join(repo, "apps/web/public/icon.svg"), path.join(output, "icon.svg"));
await writeFile(path.join(output, "OSS-ASSETS.json"), JSON.stringify({ schema: 1, included: ["characters/vroid-b", "characters/vrm-sample", "demo", "icon.svg"], modelLicenses: ["characters/vroid-b/LICENSE.md", "characters/vrm-sample/LICENSE.md"], paidAvatarRequired: false }, null, 2));
console.log("OSS public assets prepared: VRM sample + icon; no Live2D Core or cloud credentials.");
