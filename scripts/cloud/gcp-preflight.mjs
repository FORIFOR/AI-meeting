#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const project = process.env.PROJECT_ID;
const region = process.env.REGION ?? "asia-northeast1";
if (!project) { console.error("PROJECT_ID is required"); process.exit(2); }
function run(args) { return execFileSync("gcloud", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
try {
  const account = run(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]).split("\n").filter(Boolean)[0];
  if (!account) throw new Error("no active gcloud account");
  const billing = run(["billing", "projects", "describe", project, "--format=value(billingEnabled)"]);
  if (billing !== "True") throw new Error(`billing is not enabled for ${project}`);
  const enabled = new Set(run(["services", "list", "--project", project, "--enabled", "--format=value(config.name)"]).split("\n").filter(Boolean));
  const required = ["run.googleapis.com", "artifactregistry.googleapis.com", "cloudbuild.googleapis.com", "secretmanager.googleapis.com", "aiplatform.googleapis.com"];
  const missing = required.filter((service) => !enabled.has(service));
  console.log(JSON.stringify({ project, region, account, billingEnabled: true, missingApis: missing }, null, 2));
  if (missing.length) { console.error(`Missing APIs: ${missing.join(", ")}`); process.exit(1); }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
