import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Dedicated allowlist: never copy the regular public/ symlinks (Core, sample Live2D,
// derived portraits, operational credit data, local model/server assets).
const output = path.join(repo, "apps/web/public-oss");
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "characters"), { recursive: true });
await cp(path.join(repo, "characters/vrm-sample"), path.join(output, "characters/vrm-sample"), { recursive: true });
await cp(path.join(repo, "apps/web/public/icon.svg"), path.join(output, "icon.svg"));
await writeFile(path.join(output, "OSS-ASSETS.json"), JSON.stringify({ schema: 1, included: ["characters/vrm-sample", "icon.svg"], modelLicense: "characters/vrm-sample/LICENSE.md", paidAvatarRequired: false }, null, 2));
console.log("OSS public assets prepared: VRM sample + icon; no Live2D Core or cloud credentials.");
