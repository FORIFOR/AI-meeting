import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

/**
 * Durable meeting records. The guide requires the scheduling intent to exist *before* the bot is
 * created, so an ambiguous create can be reconciled instead of blindly retried.
 * File-backed (one JSON per record, atomic tmp+rename) — the repo has no database.
 */

export type MeetingStatus =
  | "intent" // persisted before the Create Bot request
  | "creating"
  | "joining_call"
  | "in_waiting_room"
  | "in_call_not_recording"
  | "in_call_recording"
  | "call_ended"
  | "done"
  | "fatal"
  | "create_failed"
  | "left";

export interface TranscriptWord {
  text: string;
  start_timestamp?: { relative?: number };
  end_timestamp?: { relative?: number };
}

export interface MeetingRecord {
  id: string;
  meetingUrl: string;
  platform: "google_meet" | "zoom" | "teams" | "webex" | "unknown";
  botId?: string;
  botName?: string;
  status: MeetingStatus;
  statusSubCode?: string | null;
  /** ISO-8601 join time when the bot was scheduled ahead of the meeting. */
  scheduledFor?: string;
  source: "url" | "calendar";
  calendarEventId?: string;
  sessionId?: string;
  recordingId?: string;
  transcriptId?: string;
  /** Path of the persisted transcript JSON, relative to the store root. */
  transcriptPath?: string;
  transcriptTextPath?: string;
  transcriptError?: string | null;
  participants?: string[];
  lifecycle: { at: string; event: string; subCode?: string | null }[];
  createdAt: string;
  updatedAt: string;
}

export function detectPlatform(url: string): MeetingRecord["platform"] {
  if (/meet\.google\.com/i.test(url)) return "google_meet";
  if (/zoom\.us|zoom\.com/i.test(url)) return "zoom";
  if (/teams\.(microsoft|live)\.com/i.test(url)) return "teams";
  if (/webex\.com/i.test(url)) return "webex";
  return "unknown";
}

export function defaultDataDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../data");
}

export class MeetingStore {
  private readonly dir: string;
  private readonly cache = new Map<string, MeetingRecord>();

  constructor(dir: string = defaultDataDir(), private readonly now: () => number = Date.now) {
    this.dir = join(dir, "meetings");
    mkdirSync(this.dir, { recursive: true });
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as MeetingRecord;
        this.cache.set(rec.id, rec);
      } catch {
        /* skip a partially written file; the tmp+rename below prevents this in practice */
      }
    }
  }

  get root(): string {
    return this.dir;
  }

  private persist(rec: MeetingRecord): void {
    const file = join(this.dir, `${rec.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, file);
    this.cache.set(rec.id, rec);
  }

  /** Step 1 of the scheduling path: record the intent, then create the bot. */
  createIntent(input: { meetingUrl: string; botName?: string; source?: MeetingRecord["source"]; calendarEventId?: string; scheduledFor?: string; sessionId?: string }): MeetingRecord {
    const at = new Date(this.now()).toISOString();
    const rec: MeetingRecord = {
      id: `mtg_${randomUUID()}`,
      meetingUrl: input.meetingUrl,
      platform: detectPlatform(input.meetingUrl),
      botName: input.botName,
      status: "intent",
      source: input.source ?? "url",
      calendarEventId: input.calendarEventId,
      scheduledFor: input.scheduledFor,
      sessionId: input.sessionId,
      lifecycle: [{ at, event: "intent" }],
      createdAt: at,
      updatedAt: at,
    };
    this.persist(rec);
    return rec;
  }

  update(id: string, patch: Partial<MeetingRecord>, event?: string): MeetingRecord | null {
    const rec = this.cache.get(id);
    if (!rec) return null;
    const at = new Date(this.now()).toISOString();
    const next: MeetingRecord = { ...rec, ...patch, updatedAt: at };
    if (event) next.lifecycle = [...rec.lifecycle, { at, event, subCode: patch.statusSubCode ?? null }];
    this.persist(next);
    return next;
  }

  get(id: string): MeetingRecord | null {
    return this.cache.get(id) ?? null;
  }

  byBot(botId: string): MeetingRecord | null {
    for (const rec of this.cache.values()) if (rec.botId === botId) return rec;
    return null;
  }

  byRecording(recordingId: string): MeetingRecord | null {
    for (const rec of this.cache.values()) if (rec.recordingId === recordingId) return rec;
    return null;
  }

  byTranscript(transcriptId: string): MeetingRecord | null {
    for (const rec of this.cache.values()) if (rec.transcriptId === transcriptId) return rec;
    return null;
  }

  byCalendarEvent(eventId: string): MeetingRecord | null {
    for (const rec of this.cache.values()) if (rec.calendarEventId === eventId) return rec;
    return null;
  }

  /** Intents that never got a bot id — reconcile these before creating another bot for the same meeting. */
  unreconciled(meetingUrl: string): MeetingRecord[] {
    return [...this.cache.values()].filter((r) => r.meetingUrl === meetingUrl && !r.botId && (r.status === "intent" || r.status === "creating"));
  }

  list(limit = 100): MeetingRecord[] {
    return [...this.cache.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  /** Store the transcript artifact next to the record; returns the relative paths. */
  saveTranscript(id: string, json: unknown, text: string): { transcriptPath: string; transcriptTextPath: string } {
    const dir = join(this.dir, "transcripts");
    mkdirSync(dir, { recursive: true });
    const jsonFile = join(dir, `${id}.json`);
    const textFile = join(dir, `${id}.txt`);
    writeFileSync(`${jsonFile}.tmp`, JSON.stringify(json, null, 2));
    renameSync(`${jsonFile}.tmp`, jsonFile);
    writeFileSync(`${textFile}.tmp`, text);
    renameSync(`${textFile}.tmp`, textFile);
    return { transcriptPath: `transcripts/${id}.json`, transcriptTextPath: `transcripts/${id}.txt` };
  }

  readTranscript(rec: MeetingRecord): { json: unknown; text: string } | null {
    if (!rec.transcriptPath) return null;
    const jsonFile = join(this.dir, rec.transcriptPath);
    if (!existsSync(jsonFile)) return null;
    const json = JSON.parse(readFileSync(jsonFile, "utf8")) as unknown;
    const textFile = rec.transcriptTextPath ? join(this.dir, rec.transcriptTextPath) : null;
    return { json, text: textFile && existsSync(textFile) ? readFileSync(textFile, "utf8") : "" };
  }
}

/**
 * Recall's transcript download payload is an array of participant-scoped utterances:
 *   [{ participant: { id, name }, words: [{ text, start_timestamp: { relative } }] }]
 * Render it as a readable transcript for the product surface.
 */
export function toReadableTranscript(data: unknown): string {
  if (!Array.isArray(data)) return "";
  const lines: string[] = [];
  for (const seg of data as { participant?: { name?: string | null }; words?: TranscriptWord[] }[]) {
    const who = seg.participant?.name ?? "Unknown";
    const text = (seg.words ?? []).map((w) => w.text).join(" ").replace(/\s+([、。？！,.!?])/g, "$1").trim();
    if (!text) continue;
    const t = seg.words?.[0]?.start_timestamp?.relative;
    const stamp = typeof t === "number" ? `[${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}] ` : "";
    lines.push(`${stamp}${who}: ${text}`);
  }
  return lines.join("\n");
}
