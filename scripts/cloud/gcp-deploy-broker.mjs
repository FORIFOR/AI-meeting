#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const vertex = process.env.GEMINI_BACKEND !== "developer";
const required = ["PROJECT_ID", "WEB_PUBLIC_URL", "MEETING_TOKEN_SECRET", ...(vertex ? [] : ["GEMINI_API_KEY"])];
for (const name of required) if (!process.env[name]) { console.error(`${name} is required`); process.exit(2); }
const webUrl = new URL(process.env.WEB_PUBLIC_URL);
if (webUrl.protocol !== "https:" || webUrl.username || webUrl.password || webUrl.search || webUrl.hash || webUrl.pathname !== "/") {
  console.error("WEB_PUBLIC_URL must be an HTTPS origin without credentials, path, query or fragment");
  process.exit(2);
}
const project = process.env.PROJECT_ID;
const region = process.env.REGION ?? "asia-northeast1";
const repo = process.env.ARTIFACT_REPOSITORY ?? "ai-meeting";
const service = process.env.SERVICE_NAME ?? "ai-meeting-broker";
const image = `${region}-docker.pkg.dev/${project}/${repo}/${service}:${process.env.IMAGE_TAG ?? "latest"}`;
const secretNames = {
  MEETING_TOKEN_SECRET: `${service}-meeting-token-secret`,
  ...(!vertex ? { GEMINI_API_KEY: `${service}-gemini-api-key` } : {}),
};
if (process.env.ATTENDEE_API_KEY) secretNames.ATTENDEE_API_KEY = `${service}-attendee-api-key`;
if (process.env.ATTENDEE_WEBHOOK_SECRET) secretNames.ATTENDEE_WEBHOOK_SECRET = `${service}-attendee-webhook-secret`;
function run(args, input) { return execFileSync("gcloud", args, { input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"] }).trim(); }
function ensureSecret(name, value) {
  try { run(["secrets", "describe", name, "--project", project]); } catch { run(["secrets", "create", name, "--project", project, "--replication-policy=automatic"]); }
  run(["secrets", "versions", "add", name, "--project", project, "--data-file=-"], `${value}\n`);
}
run(["config", "set", "project", project]);
run(["services", "enable", "run.googleapis.com", "artifactregistry.googleapis.com", "cloudbuild.googleapis.com", "secretmanager.googleapis.com", "aiplatform.googleapis.com"]);
try { run(["artifacts", "repositories", "describe", repo, "--location", region, "--project", project]); } catch { run(["artifacts", "repositories", "create", repo, "--repository-format=docker", "--location", region, "--project", project, "--description=AI Meeting images"]); }
for (const [key, name] of Object.entries(secretNames)) ensureSecret(name, process.env[key]);
run(["builds", "submit", ".", "--project", project, "--config", "deploy/gcp/cloudbuild.broker.yaml", `--substitutions=_IMAGE=${image}`]);
const envVars = ["HOST=0.0.0.0", "RCAI_RELEASE_CHANNEL=beta", "ATTENDEE_API_BASE_URL=https://app.attendee.dev"];
if (process.env.BROKER_PUBLIC_URL) envVars.push(`RECALL_PUBLIC_URL=${process.env.BROKER_PUBLIC_URL}`);
envVars.push(`RECALL_BOT_PAGE_URL=${webUrl.origin}/agent/runtime`);
if (vertex) envVars.push("GEMINI_BACKEND=vertex", `GOOGLE_CLOUD_PROJECT=${project}`, `GOOGLE_CLOUD_LOCATION=${process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1"}`, `VERTEX_LIVE_MODEL=${process.env.VERTEX_LIVE_MODEL ?? "gemini-live-2.5-flash-native-audio"}`);
else envVars.push("GEMINI_BACKEND=developer");
const deployArgs = ["run", "deploy", service, "--project", project, "--region", region, "--image", image, "--platform", "managed", "--allow-unauthenticated", "--port", "8787", "--timeout", "3600", "--min", "0", "--max", process.env.MAX_INSTANCES ?? "1", "--set-env-vars", envVars.join(",")];
if (Object.keys(secretNames).length) deployArgs.push("--set-secrets", Object.entries(secretNames).map(([key, name]) => `${key}=${name}:latest`).join(","));
run(deployArgs);
const url = run(["run", "services", "describe", service, "--project", project, "--region", region, "--format=value(status.url)"]);
if (!url) throw new Error("Cloud Run returned no service URL");
console.log(JSON.stringify({ service, region, url, image, webPublicUrl: process.env.WEB_PUBLIC_URL, deployedAt: new Date().toISOString() }, null, 2));
