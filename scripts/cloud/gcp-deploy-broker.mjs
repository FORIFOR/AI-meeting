#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const required = ["PROJECT_ID", "BROKER_PUBLIC_URL", "WEB_PUBLIC_URL", "MEETING_TOKEN_SECRET", "GEMINI_API_KEY", "ATTENDEE_API_KEY", "ATTENDEE_WEBHOOK_SECRET"];
for (const name of required) if (!process.env[name]) { console.error(`${name} is required`); process.exit(2); }
const project = process.env.PROJECT_ID;
const region = process.env.REGION ?? "asia-northeast1";
const repo = process.env.ARTIFACT_REPOSITORY ?? "ai-meeting";
const service = process.env.SERVICE_NAME ?? "ai-meeting-broker";
const image = `${region}-docker.pkg.dev/${project}/${repo}/${service}:${process.env.IMAGE_TAG ?? "latest"}`;
const secretNames = {
  MEETING_TOKEN_SECRET: `${service}-meeting-token-secret`,
  GEMINI_API_KEY: `${service}-gemini-api-key`,
  ATTENDEE_API_KEY: `${service}-attendee-api-key`,
  ATTENDEE_WEBHOOK_SECRET: `${service}-attendee-webhook-secret`,
};
function run(args, input) { return execFileSync("gcloud", args, { input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"] }).trim(); }
function ensureSecret(name, value) {
  try { run(["secrets", "describe", name, "--project", project]); } catch { run(["secrets", "create", name, "--project", project, "--replication-policy=automatic"]); }
  run(["secrets", "versions", "add", name, "--project", project, "--data-file=-"], `${value}\n`);
}
run(["config", "set", "project", project]);
run(["services", "enable", "run.googleapis.com", "artifactregistry.googleapis.com", "cloudbuild.googleapis.com", "secretmanager.googleapis.com"]);
try { run(["artifacts", "repositories", "describe", repo, "--location", region, "--project", project]); } catch { run(["artifacts", "repositories", "create", repo, "--repository-format=docker", "--location", region, "--project", project, "--description=AI Meeting images"]); }
for (const [key, name] of Object.entries(secretNames)) ensureSecret(name, process.env[key]);
run(["builds", "submit", ".", "--project", project, "--tag", image, "--file", "deploy/cloud/Dockerfile.broker"]);
run(["run", "deploy", service, "--project", project, "--region", region, "--image", image, "--platform", "managed", "--allow-unauthenticated", "--port", "8787", "--min", "0", "--max", process.env.MAX_INSTANCES ?? "1", "--set-env-vars", ["HOST=0.0.0.0", "RCAI_RELEASE_CHANNEL=beta", "ATTENDEE_API_BASE_URL=https://app.attendee.dev", `RECALL_PUBLIC_URL=${process.env.BROKER_PUBLIC_URL}`, `RECALL_BOT_PAGE_URL=${process.env.WEB_PUBLIC_URL}/agent/runtime`].join(","), "--set-secrets", Object.entries(secretNames).map(([key, name]) => `${key}=${name}:latest`).join(",")]);
const url = run(["run", "services", "describe", service, "--project", project, "--region", region, "--format=value(status.url)"]);
if (!url) throw new Error("Cloud Run returned no service URL");
console.log(JSON.stringify({ service, region, url, image, webPublicUrl: process.env.WEB_PUBLIC_URL, deployedAt: new Date().toISOString() }, null, 2));
