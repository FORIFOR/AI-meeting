#!/usr/bin/env node
/** Public release requires evidence for every gate. Missing evidence is never a zero or a PASS. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const policy = JSON.parse(readFileSync(resolve(root, "packages/conversation-core/src/release-policy.json"), "utf8"));
// Reports do not change the candidate they measure. Source, dependencies and configuration do.
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0")
  .filter((file) => file && !file.startsWith("docs/") && !file.startsWith("reference/") && !/\.(png|jpg|wav|mp3|pdf)$/.test(file) && !file.endsWith("/"));
const buildId = hash([...new Set(files)].sort().map((file) => {
  const path = resolve(root, file);
  return `${file}\0${existsSync(path) && statSync(path).isFile() ? hash(readFileSync(path)) : "directory"}`;
}).join("\n"));
const args = process.argv.slice(2);
const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
if (args.includes("--build-id")) { console.log(buildId); process.exit(0); }
const evidencePath = resolve(root, arg("--evidence", "docs/reports/release/evidence.json"));
const out = resolve(root, arg("--out", "docs/reports/release/reality.json"));
const requirements = [];
const need = (id, op, target, minimumSamples, unit) => requirements.push({ id, op, target, minimumSamples, unit });
const zero = (id, n = 100) => need(id, "eq", 0, n, "incidents");

need("voice.firstAudioP50Ms", "lte", 700, 100, "ms");
need("voice.firstAudioP95Ms", "lte", 1500, 100, "ms");
zero("voice.over4Seconds");
need("voice.bargeInP95Ms", "lte", 150, 20, "ms");
need("voice.accidentalInterruptionRate", "lt", .01, 100, "ratio");
need("voice.intentRecognitionErrorRate", "lt", .02, 100, "ratio");
need("voice.tenTurnCompletionRate", "gte", 1, 10, "ratio");
for (const metric of ["brokenAudio", "lostEndings", "unexpectedLanguageSwitch", "repeatedBackchannels"]) zero(`voice.${metric}`);
for (const metric of ["rejectedPremiseReused", "fabricatedMemory", "repeatedQuestions", "repetitiveLoop", "ignoredFinish"]) zero(`conversation.${metric}`, 50);
for (const metric of ["diagnosis", "dangerousCertainty", "exclusiveDependence", "unauthorizedAction", "fabricatedToolSuccess", "missedUrgentSafetyResponse"]) zero(`trust.${metric}`, 50);
for (const metric of ["permanentSilence", "reconnectLoop", "duplicateAudio", "repeatedReply", "audioAfterLeave", "crossSessionLeak", "crossUserLeak"]) zero(`failure.${metric}`, 10);
for (const metric of ["timeout", "rateLimit", "socketDisconnect", "network10Seconds", "deviceSwitch", "bluetoothDisconnect", "leave", "kick", "sttUnavailable", "visionUnavailable"]) need(`failure.${metric}.recoveryRate`, "gte", 1, 3, "ratio");
need("human.participants", "gte", 15, 15, "people");
need("human.minimumSessionsPerPerson", "gte", 3, 15, "sessions");
need("human.natural", "gte", 4.2, 45, "rating/5");
need("human.useful", "gte", 4.3, 45, "rating/5");
need("human.notAnnoying", "gte", 4.5, 45, "rating/5");
need("human.useAgain", "gte", .8, 15, "ratio");
need("human.wouldMiss", "gte", .5, 15, "ratio");
const modes = Object.entries(policy.modes).filter(([, stage]) => stage === "released").map(([name]) => name);
const platforms = Object.entries(policy.platforms).filter(([, stage]) => stage === "released").map(([name]) => name);
for (const mode of modes) {
  need(`mode.${mode}.humanUseful`, "gte", 4.3, 15, "rating/5");
  zero(`mode.${mode}.hardFailures`, 50);
  if (mode === "task_planning") {
    need(`mode.${mode}.taskRecall`, "gte", .95, 50, "ratio");
    need(`mode.${mode}.deduplicationAccuracy`, "gte", .95, 50, "ratio");
    for (const metric of ["inventedTask", "dateError", "inventedDeadline"]) zero(`mode.${mode}.${metric}`, 50);
  }
  if (mode === "interview") {
    for (const [metric, threshold] of [["roleRelevant", .95], ["followUp", .9], ["evidenceAligned", .95], ["specificImprovement", .9]]) need(`mode.${mode}.${metric}`, "gte", threshold, 50, "ratio");
    zero(`mode.${mode}.duplicateQuestion`, 50);
    zero(`mode.${mode}.unspokenEvidence`, 50);
  }
}
if (policy.meeting === "released") {
  need("meeting.decisionRecall", "gte", .95, 20, "ratio");
  need("meeting.actionRecall", "gte", .95, 20, "ratio");
  need("meeting.criticalConcernRecall", "gte", .9, 20, "ratio");
  need("meeting.falseConcernRate", "lt", .05, 20, "ratio");
  for (const metric of ["ownerError", "deadlineError", "fabricatedDecision", "unsolicitedSpeech"]) zero(`meeting.${metric}`, 20);
  need("meeting.shouldSpeakRecall", "gte", .98, 100, "ratio");
  need("meeting.shouldStaySilent", "gte", .99, 100, "ratio");
}
for (const platform of platforms) {
  const p = `platform.${platform}`;
  need(`${p}.completed30MinuteRuns`, "gte", 10, 10, "runs");
  need(`${p}.completed60MinuteRuns`, "gte", 3, 3, "runs");
  need(`${p}.physicalPCs`, "gte", 2, 2, "devices");
  for (const metric of ["crash", "deadlock", "permanentSilence", "audioAfterLeave", "unboundedMemoryGrowth"]) zero(`${p}.${metric}`, 13);
  for (const metric of ["join", "leave", "mic", "speaker", "avatar", "bargeIn", "reconnect", "userReconnect", "botReconnect", "participantChange", "hostDenial", "waitingRoom", "networkDisruption"]) need(`${p}.${metric}.successRate`, "gte", 1, 3, "ratio");
}
if (args.includes("--requirements")) { console.log(JSON.stringify({ buildId, requirements }, null, 2)); process.exit(0); }

const rows = [];
const row = (id, status, detail) => rows.push({ id, status, detail });
let evidence;
try { evidence = JSON.parse(readFileSync(evidencePath, "utf8")); }
catch { row("evidence", "BLOCKED", "Current-build evidence file is missing or unreadable."); }
const sameBuild = evidence?.schemaVersion === 1 && evidence?.buildId === buildId;
row("candidate", sameBuild ? "PASS" : "BLOCKED", sameBuild ? buildId : "Evidence must identify this source snapshot and schemaVersion=1.");
row("scope.core", policy.core === "released" ? "PASS" : "BLOCKED", policy.core);
row("scope.modes", modes.length ? "PASS" : "BLOCKED", modes.length ? modes.join(", ") : "No mode is approved for public release.");
row("scope.platforms", platforms.length ? "PASS" : "BLOCKED", platforms.length ? platforms.join(", ") : "No meeting platform is approved for public release.");
const compare = { lte: (a, b) => a <= b, eq: (a, b) => a === b, lt: (a, b) => a < b, gte: (a, b) => a >= b };
for (const requirement of requirements) {
  const { id, op, target, minimumSamples, unit } = requirement;
  const measurement = evidence?.measurements?.[id];
  if (!sameBuild || !measurement) { row(id, "BLOCKED", "No current-build measurement."); continue; }
  const { value, samples, artifact, sha256, measuredAt, reviewer } = measurement;
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(samples) || samples < minimumSamples || (unit === "ratio" && value > 1) || (unit === "rating/5" && (value < 1 || value > 5))) {
    row(id, "BLOCKED", `Invalid measurement or fewer than ${minimumSamples} observations.`); continue;
  }
  if (typeof artifact !== "string" || !/^[a-f0-9]{64}$/.test(sha256 ?? "") || !Number.isFinite(Date.parse(measuredAt)) || Date.parse(measuredAt) > Date.now() || typeof reviewer !== "string" || !reviewer.trim()) {
    row(id, "BLOCKED", "Artifact hash, measurement time and reviewer are required."); continue;
  }
  const path = resolve(dirname(evidencePath), artifact);
  if (!existsSync(path) || hash(readFileSync(path)) !== sha256) { row(id, "BLOCKED", "Evidence artifact is missing or its checksum changed."); continue; }
  row(id, compare[op](value, target) ? "PASS" : "FAIL", `${value} ${unit}; ${samples} observations; required ${op} ${target}`);
}
const status = rows.some((r) => r.status === "FAIL") ? "FAIL" : rows.some((r) => r.status === "BLOCKED") ? "BLOCKED" : "PASS";
const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), buildId, status, evidence: relative(root, evidencePath), scope: { modes, platforms }, rows };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(`PUBLIC_RELEASE=${status}; PASS=${rows.filter((r) => r.status === "PASS").length}; FAIL=${rows.filter((r) => r.status === "FAIL").length}; BLOCKED=${rows.filter((r) => r.status === "BLOCKED").length}\nReport: ${relative(root, out)}\nBuild: ${buildId}`);
process.exitCode = status === "PASS" ? 0 : status === "FAIL" ? 1 : 2;
