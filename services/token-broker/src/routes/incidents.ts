import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Presence incident (Round 3 Gate 6) as produced by apps/web `IncidentRecorder`.
 * Media fields are only present when the tester explicitly opted in; they are written as
 * separate files next to the JSON so the JSON stays greppable.
 */
export interface IncidentBody {
  id: string;
  sessionId: string;
  at: number;
  windowMs: number;
  reason: string;
  note?: string;
  provider?: string | null;
  avatarState?: string;
  entries?: unknown[];
  hud?: unknown;
  userOptIn?: { audio?: boolean; video?: boolean };
  micWavBase64?: string;
  assistantWavBase64?: string;
  videoFrameJpegBase64?: string;
  mode?: string;
  characterId?: string;
}

export interface IncidentDeps {
  /** Base dir for `<sessionId>/<id>.json`. Default docs/reports/human/incidents relative to the repo. */
  dir?: string;
  write?: (file: string, data: string | Uint8Array) => Promise<void>;
  now?: () => number;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_ENTRIES = 5000;
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

export async function recordIncident(body: IncidentBody, deps: IncidentDeps = {}): Promise<{ status: number; body: { ok: true; file: string; media: string[] } | { error: string } }> {
  if (!body || typeof body !== "object") return { status: 400, body: { error: "incident body required" } };
  if (typeof body.id !== "string" || !SAFE_ID.test(body.id)) return { status: 400, body: { error: "invalid id" } };
  if (typeof body.sessionId !== "string" || !SAFE_ID.test(body.sessionId)) return { status: 400, body: { error: "invalid sessionId" } };
  if (typeof body.at !== "number" || typeof body.reason !== "string") return { status: 400, body: { error: "at/reason required" } };
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, MAX_ENTRIES) : [];
  const optIn = { audio: body.userOptIn?.audio === true, video: body.userOptIn?.video === true };
  // Media is accepted only when the incident itself says the tester opted in (defence in depth).
  const media: { suffix: string; b64: string }[] = [];
  if (optIn.audio && typeof body.micWavBase64 === "string") media.push({ suffix: ".mic.wav", b64: body.micWavBase64 });
  if (optIn.audio && typeof body.assistantWavBase64 === "string") media.push({ suffix: ".assistant.wav", b64: body.assistantWavBase64 });
  if (optIn.video && typeof body.videoFrameJpegBase64 === "string") media.push({ suffix: ".jpg", b64: body.videoFrameJpegBase64 });
  for (const m of media) if (m.b64.length > (MAX_MEDIA_BYTES * 4) / 3) return { status: 413, body: { error: "media too large" } };

  const dir = join(deps.dir ?? join(process.cwd(), "..", "..", "docs", "reports", "human", "incidents"), body.sessionId);
  const write = deps.write ?? (async (f, d) => { await mkdir(dir, { recursive: true }); await writeFile(f, d); });
  const { micWavBase64: _a, assistantWavBase64: _b, videoFrameJpegBase64: _c, ...rest } = body;
  const file = join(dir, `${body.id}.json`);
  const written: string[] = [];
  await write(file, JSON.stringify({ ...rest, entries, userOptIn: optIn, media: media.map((m) => `${body.id}${m.suffix}`), receivedAt: (deps.now ?? Date.now)() }, null, 2));
  for (const m of media) {
    const f = join(dir, `${body.id}${m.suffix}`);
    await write(f, new Uint8Array(Buffer.from(m.b64, "base64")));
    written.push(f);
  }
  return { status: 200, body: { ok: true, file, media: written } };
}
