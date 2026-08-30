import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Human Reality Gate observation (docs/human-gate.md). No audio, no secrets. */
export interface FeedbackEntry {
  sessionId?: string;
  at: number;
  kind: "observation" | "rating" | "note";
  tag?: string;
  avatarState?: string;
  captions?: string[];
  rating?: Record<string, number>;
  note?: string;
  mode?: string;
  characterId?: string;
  providerId?: string;
  tester?: string;
}

export interface FeedbackDeps {
  /** Directory for `<date>.jsonl` files. Default: docs/reports/human relative to cwd. */
  dir?: string;
  append?: (file: string, line: string) => Promise<void>;
  now?: () => number;
}

const MAX_ENTRIES = 500;

export async function recordFeedback(body: { entries?: FeedbackEntry[] } | FeedbackEntry, deps: FeedbackDeps = {}): Promise<{ status: number; body: { ok: true; written: number; file: string } | { error: string } }> {
  const entries = Array.isArray((body as { entries?: FeedbackEntry[] }).entries) ? (body as { entries: FeedbackEntry[] }).entries : [body as FeedbackEntry];
  const clean = entries.filter((e) => e && typeof e === "object" && typeof e.at === "number" && ["observation", "rating", "note"].includes(e.kind)).slice(0, MAX_ENTRIES);
  if (!clean.length) return { status: 400, body: { error: "no valid entries" } };
  const now = deps.now ?? Date.now;
  const date = new Date(now()).toISOString().slice(0, 10);
  const dir = deps.dir ?? join(process.cwd(), "..", "..", "docs", "reports", "human");
  const file = join(dir, `${date}.jsonl`);
  const lines = clean.map((e) => JSON.stringify({ ...e, receivedAt: now() })).join("\n") + "\n";
  const append = deps.append ?? (async (f, l) => { await mkdir(dir, { recursive: true }); await appendFile(f, l, "utf8"); });
  await append(file, lines);
  return { status: 200, body: { ok: true, written: clean.length, file } };
}
