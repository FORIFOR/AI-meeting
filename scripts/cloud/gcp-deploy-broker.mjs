#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const vertex = process.env.GEMINI_BACKEND !== "developer";
// Hosted credentials are never taken from the local/self-hosted Attendee environment.
const hostedKey = process.env.HOSTED_ATTENDEE_API_KEY?.trim();
if (process.env.ATTENDEE_API_KEY && !hostedKey) {
  console.error("BLOCKED: use a dedicated HOSTED_ATTENDEE_API_KEY; ATTENDEE_API_KEY may belong to a local server.");
  process.exit(2);
}
if (hostedKey) {
  try {
    const response = await fetch("https://app.attendee.dev/api/v1/bots", {
      headers: { Authorization: `Token ${hostedKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(15000), redirect: "error",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log("Hosted Attendee authentication passed (read-only; admission and credit balance remain unverified).");
  } catch (error) {
    console.error(`BLOCKED: Hosted Attendee authentication failed (${error.message}). No deployment changes made.`);
    process.exit(2);
  }
}
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
if (hostedKey) secretNames.ATTENDEE_API_KEY = `${service}-hosted-attendee-api-key`;
if (process.env.HOSTED_ATTENDEE_WEBHOOK_SECRET) secretNames.ATTENDEE_WEBHOOK_SECRET = `${service}-hosted-attendee-webhook-secret`;
function run(args, input) { return execFileSync("gcloud", args, { input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"] }).trim(); }
function ensureSecret(name, value) {
  try { run(["secrets", "describe", name, "--project", project]); } catch { run(["secrets", "create", name, "--project", project, "--replication-policy=automatic"]); }
  run(["secrets", "versions", "add", name, "--project", project, "--data-file=-"], value);
}
run(["config", "set", "project", project]);
run(["services", "enable", "run.googleapis.com", "artifactregistry.googleapis.com", "cloudbuild.googleapis.com", "secretmanager.googleapis.com", "aiplatform.googleapis.com"]);
try { run(["artifacts", "repositories", "describe", repo, "--location", region, "--project", project]); } catch { run(["artifacts", "repositories", "create", repo, "--repository-format=docker", "--location", region, "--project", project, "--description=AI Meeting images"]); }
for (const [key, name] of Object.entries(secretNames)) ensureSecret(name,
  key === "ATTENDEE_API_KEY" ? hostedKey : key === "ATTENDEE_WEBHOOK_SECRET" ? process.env.HOSTED_ATTENDEE_WEBHOOK_SECRET : process.env[key]);
run(["builds", "submit", ".", "--project", project, "--config", "deploy/gcp/cloudbuild.broker.yaml", `--substitutions=_IMAGE=${image}`]);
const envVars = ["HOST=0.0.0.0", "RCAI_RELEASE_CHANNEL=beta", "ATTENDEE_API_BASE_URL=https://app.attendee.dev"];
// Incremental deployments preserve separately configured access policy/OAuth settings.
for (const key of ["RCAI_PUBLIC_DEMO_ONLY", "ZOOM_OAUTH_CLIENT_ID", "ZOOM_OAUTH_CALLBACK_URL", "ZOOM_OAUTH_WEB_ORIGIN", "ZOOM_FIRESTORE_DATABASE", "ZOOM_REQUIRE_AUTH"]) {
  if (process.env[key]) envVars.push(`${key}=${process.env[key]}`);
}
if (process.env.BROKER_PUBLIC_URL) envVars.push(`RECALL_PUBLIC_URL=${process.env.BROKER_PUBLIC_URL}`);
// Firebase Hosting serves the bot page from the SPA entry point. Keep this at the
// origin so output-media/Attendee links never point at an un-deployed sub-path
// (which otherwise renders Firebase's Page Not Found screen).
envVars.push(`RECALL_BOT_PAGE_URL=${webUrl.origin}`);
if (vertex) envVars.push("GEMINI_BACKEND=vertex", `GOOGLE_CLOUD_PROJECT=${project}`, `GOOGLE_CLOUD_LOCATION=${process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1"}`, `VERTEX_LIVE_MODEL=${process.env.VERTEX_LIVE_MODEL ?? "gemini-live-2.5-flash-native-audio"}`);
else envVars.push("GEMINI_BACKEND=developer");
const deployArgs = ["run", "deploy", service, "--project", project, "--region", region, "--image", image, "--platform", "managed", "--allow-unauthenticated", "--port", "8787", "--timeout", "3600", "--min", "0", "--max", process.env.MAX_INSTANCES ?? "1", "--update-env-vars", envVars.join(",")];
if (Object.keys(secretNames).length) deployArgs.push("--set-secrets", Object.entries(secretNames).map(([key, name]) => `${key}=${name}:latest`).join(","));
run(deployArgs);
const url = run(["run", "services", "describe", service, "--project", project, "--region", region, "--format=value(status.url)"]);
if (!url) throw new Error("Cloud Run returned no service URL");
console.log(JSON.stringify({ service, region, url, image, webPublicUrl: process.env.WEB_PUBLIC_URL, deployedAt: new Date().toISOString() }, null, 2));
