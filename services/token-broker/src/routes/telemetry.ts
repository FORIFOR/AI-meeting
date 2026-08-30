import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Keys that could carry user content are refused outright (Round 3 Gate 7). */
const CONTENT_KEY = /^(text|transcript|transcripts|caption|captions|prompt|content|quote|note|notes|utterance|audio|video|image|micWavBase64|assistantWavBase64)$/i;

export function findContentKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findContentKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CONTENT_KEY.test(k)) return path ? `${path}.${k}` : k;
      const hit = findContentKey(v, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
  }
  return null;
}

export interface TelemetryDeps {
  dir?: string;
  append?: (file: string, line: string) => Promise<void>;
  now?: () => number;
}

export async function recordTelemetry(body: unknown, deps: TelemetryDeps = {}): Promise<{ status: number; body: { ok: true; file: string } | { error: string; key?: string } }> {
  if (!body || typeof body !== "object") return { status: 400, body: { error: "telemetry body required" } };
  const env = body as { schema?: string; report?: { sessionId?: string } };
  if (env.schema !== "rcai.telemetry.v1" || !env.report || typeof env.report.sessionId !== "string") return { status: 400, body: { error: "expected rcai.telemetry.v1 envelope with report.sessionId" } };
  const key = findContentKey(body);
  if (key) return { status: 400, body: { error: "user content is not accepted by telemetry", key } };
  const raw = JSON.stringify(body);
  if (raw.length > 256 * 1024) return { status: 413, body: { error: "telemetry too large" } };
  const now = deps.now ?? Date.now;
  const dir = deps.dir ?? join(process.cwd(), "..", "..", "docs", "reports", "telemetry");
  const file = join(dir, `${new Date(now()).toISOString().slice(0, 10)}.jsonl`);
  const append = deps.append ?? (async (f, l) => { await mkdir(dir, { recursive: true }); await appendFile(f, l, "utf8"); });
  await append(file, JSON.stringify({ ...(body as object), receivedAt: now() }) + "\n");
  return { status: 200, body: { ok: true, file } };
}
