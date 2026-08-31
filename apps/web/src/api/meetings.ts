import { readError } from "./health.js";

/**
 * Meetings the character was sent to, and the calendar events it will be sent to.
 * The backend (token-broker) owns Recall credentials; this module only reads its REST surface
 * and turns codes into sentences a person can read (docs/ui-design.md: no raw codes in the flow).
 */

export type MeetingSource = "url" | "calendar";

export interface MeetingRecord {
  id: string;
  meetingUrl: string;
  platform?: string;
  botId?: string;
  status: string;
  statusSubCode?: string;
  scheduledFor?: string;
  source: MeetingSource;
  recordingId?: string;
  transcriptId?: string;
  hasTranscript: boolean;
  title?: string;
  createdAt: string;
  updatedAt: string;
  participants?: string[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  meetingUrl?: string;
  eligible: boolean;
  reason: string;
  botId?: string;
}

export interface CalendarStatus {
  connected: boolean;
  platformEmail?: string;
  syncState?: string;
  readyForTesting?: boolean;
  blocked?: string;
}

export interface MeetingRule {
  markers: string[];
  leadMinutes: number;
}

export interface Utterance {
  speaker?: string;
  text: string;
  startMs?: number;
  endMs?: number;
}

export interface TranscriptPayload {
  utterances?: Utterance[];
  words?: Utterance[];
  text?: string;
}

// ---------------------------------------------------------------- pure helpers

/** Why the character will (not) join, in a sentence. The raw code stays in a title attribute. */
export function reasonJa(reason: string, rule?: MeetingRule): string {
  const marker = rule?.markers?.[0] ?? "#yui";
  switch (reason) {
    case "marker":
    case "marker_match":
      return `タイトルに ${marker} があります`;
    case "opted_in":
      return "参加する設定にしました";
    case "no_marker":
    case "marker_missing":
      return `タイトルに ${marker} がありません`;
    case "opted_out":
      return "参加しない設定です";
    case "past":
    case "past_event":
      return "過去の予定です";
    case "no_meeting_link":
    case "no_meeting_url":
      return "会議リンクがありません";
    case "cancelled":
    case "deleted":
      return "取り消された予定です";
    case "declined":
      return "参加を辞退した予定です";
    case "already_scheduled":
      return "すでに手配済みです";
    case "calendar_disconnected":
      return "カレンダーが未接続です";
    default:
      return "この予定は対象外です";
  }
}

const STATUS_JA: Record<string, string> = {
  created: "手配済み",
  scheduled: "手配済み",
  joining: "参加中",
  joining_call: "参加中",
  waiting_room: "待機室で承認待ち",
  in_waiting_room: "待機室で承認待ち",
  in_call_not_recording: "入室（記録前）",
  in_call: "会議中",
  in_call_recording: "会議中",
  reconnecting: "再接続中",
  leaving: "退出中",
  left: "退出しました",
  call_ended: "会議が終了しました",
  ended: "会議が終了しました",
  done: "終了しました",
  denied: "入室を断られました",
  removed: "ホストに退出させられました",
  failed: "参加できませんでした",
  fatal: "参加できませんでした",
};

export function statusJa(status: string): string {
  return STATUS_JA[status] ?? STATUS_JA[status.replace(/^bot\./, "")] ?? "状態を確認中";
}

/** One plain sentence for a lifecycle or transcript failure — never a code dump. */
export function failureSentence(m: Pick<MeetingRecord, "status" | "statusSubCode" | "hasTranscript">): string | null {
  const s = m.status.replace(/^bot\./, "");
  if (s === "failed" || s === "fatal") return "この会議には参加できませんでした。";
  if (s === "denied") return "ホストが入室を承認しなかったため参加できませんでした。";
  if (s === "removed") return "会議中にホストが退出させたため、途中までの記録です。";
  if (s === "transcript_failed") return "文字起こしを作成できませんでした。";
  return null;
}

export function isFinished(m: Pick<MeetingRecord, "status">): boolean {
  const s = m.status.replace(/^bot\./, "");
  return ["left", "ended", "call_ended", "done", "failed", "fatal", "denied", "removed", "transcript_failed"].includes(s);
}

/** Upcoming first (soonest at the top), past after (most recent at the top). */
export function splitEvents(events: CalendarEvent[], now: number = Date.now()): { upcoming: CalendarEvent[]; past: CalendarEvent[] } {
  const upcoming: CalendarEvent[] = [];
  const past: CalendarEvent[] = [];
  for (const e of events) {
    const end = e.endsAt ? Date.parse(e.endsAt) : Date.parse(e.startsAt);
    (Number.isFinite(end) && end < now ? past : upcoming).push(e);
  }
  upcoming.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  past.sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  return { upcoming, past };
}

/** Finished meetings, most recent first. */
export function sortMeetings(records: MeetingRecord[]): MeetingRecord[] {
  return [...records].sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
}

export interface DialogueBlock {
  speaker: string;
  text: string;
  startMs?: number;
}

/** Consecutive utterances from one speaker become one paragraph — a transcript, not a word list. */
export function groupUtterances(payload: TranscriptPayload | null | undefined): DialogueBlock[] {
  const items = payload?.utterances ?? payload?.words ?? [];
  const out: DialogueBlock[] = [];
  for (const u of items) {
    const text = (u.text ?? "").trim();
    if (!text) continue;
    const speaker = (u.speaker ?? "").trim() || "話者不明";
    const last = out[out.length - 1];
    if (last && last.speaker === speaker) last.text = `${last.text}${/[。、！？!?,.]$/.test(last.text) ? "" : " "}${text}`.trim();
    else out.push({ speaker, text, startMs: u.startMs });
  }
  return out;
}

export function blocksToText(blocks: DialogueBlock[]): string {
  return blocks.map((b) => `${b.speaker}: ${b.text}`).join("\n");
}

export function clockLabel(ms?: number): string {
  if (!Number.isFinite(ms as number)) return "";
  const total = Math.max(0, Math.round((ms as number) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function timeLabel(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

// ---------------------------------------------------------------- API client

async function getJson<T>(url: string, timeoutMs = 6000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(await readError(r));
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function send<T>(url: string, method: "POST" | "PUT", body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json().catch(() => ({}))) as T;
}

const base = (brokerUrl: string) => brokerUrl.replace(/\/$/, "");

export const meetingsApi = {
  list: (brokerUrl: string) => getJson<MeetingRecord[]>(`${base(brokerUrl)}/api/meetings`),
  get: (brokerUrl: string, id: string) => getJson<MeetingRecord>(`${base(brokerUrl)}/api/meetings/${encodeURIComponent(id)}`),
  transcript: (brokerUrl: string, id: string) => getJson<TranscriptPayload>(`${base(brokerUrl)}/api/meetings/${encodeURIComponent(id)}/transcript`),
  calendarStatus: (brokerUrl: string) => getJson<CalendarStatus>(`${base(brokerUrl)}/api/calendar/status`),
  calendarEvents: (brokerUrl: string) => getJson<CalendarEvent[]>(`${base(brokerUrl)}/api/calendar/events`),
  optIn: (brokerUrl: string, id: string) => send<{ ok: true }>(`${base(brokerUrl)}/api/calendar/events/${encodeURIComponent(id)}/optin`, "POST"),
  optOut: (brokerUrl: string, id: string) => send<{ ok: true }>(`${base(brokerUrl)}/api/calendar/events/${encodeURIComponent(id)}/optout`, "POST"),
  rule: (brokerUrl: string) => getJson<MeetingRule>(`${base(brokerUrl)}/api/calendar/rule`),
  saveRule: (brokerUrl: string, rule: MeetingRule) => send<MeetingRule>(`${base(brokerUrl)}/api/calendar/rule`, "PUT", rule),
};

export const DEFAULT_RULE: MeetingRule = { markers: ["#yui"], leadMinutes: 2 };
