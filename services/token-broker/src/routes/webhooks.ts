import type { RecallClient } from "../recall/client.js";
import type { Job } from "../recall/queue.js";
import { toReadableTranscript, type MeetingStatus, type MeetingStore } from "../recall/store.js";

/**
 * Dashboard (Svix) webhook handling for API v1.11.
 *
 * Events (exact names, docs.recall.ai/docs/bot-status-change-events + recording/transcript webhooks):
 *   bot.joining_call · bot.in_waiting_room · bot.in_call_not_recording · bot.recording_permission_allowed
 *   bot.recording_permission_denied · bot.in_call_recording · bot.call_ended · bot.done · bot.fatal
 *   recording.done · transcript.done · transcript.failed
 *
 * Lifecycle we implement: recording.done → Create Async Transcript → transcript.done → retrieve →
 * download → persist. No polling anywhere (guide) and at most one transcript per recording.
 */

export const DASHBOARD_EVENTS = [
  "bot.joining_call",
  "bot.in_waiting_room",
  "bot.in_call_not_recording",
  "bot.recording_permission_allowed",
  "bot.recording_permission_denied",
  "bot.in_call_recording",
  "bot.call_ended",
  "bot.done",
  "bot.fatal",
  "recording.done",
  "transcript.done",
  "transcript.failed",
] as const;

const BOT_STATUS: Record<string, MeetingStatus> = {
  "bot.joining_call": "joining_call",
  "bot.in_waiting_room": "in_waiting_room",
  "bot.in_call_not_recording": "in_call_not_recording",
  "bot.in_call_recording": "in_call_recording",
  "bot.call_ended": "call_ended",
  "bot.done": "done",
  "bot.fatal": "fatal",
};

export interface WebhookEnvelope {
  event?: string;
  data?: {
    data?: { code?: string; sub_code?: string | null; updated_at?: string };
    bot?: { id?: string; metadata?: Record<string, string> };
    recording?: { id?: string; bot?: { id?: string }; metadata?: Record<string, string> };
    transcript?: { id?: string; recording?: { id?: string } };
    status?: { code?: string; sub_code?: string | null };
  };
}

export interface WebhookDeps {
  store: MeetingStore;
  client: RecallClient;
  /** Language for async transcription; "auto" lets Recall detect it. */
  transcriptLanguage?: string;
  log?: (line: Record<string, unknown>) => void;
}

/** Locate the meeting record a webhook belongs to, using our own metadata first. */
function locate(store: MeetingStore, env: WebhookEnvelope) {
  const d = env.data ?? {};
  const metaId = d.bot?.metadata?.meetingRecordId ?? d.recording?.metadata?.meetingRecordId;
  if (metaId) {
    const byMeta = store.get(metaId);
    if (byMeta) return byMeta;
  }
  const botId = d.bot?.id ?? d.recording?.bot?.id;
  if (botId) {
    const byBot = store.byBot(botId);
    if (byBot) return byBot;
  }
  const recordingId = d.recording?.id ?? d.transcript?.recording?.id;
  if (recordingId) {
    const byRec = store.byRecording(recordingId);
    if (byRec) return byRec;
  }
  const transcriptId = d.transcript?.id;
  if (transcriptId) return store.byTranscript(transcriptId);
  return null;
}

/**
 * Process one verified webhook. Runs in the queue worker, never in the HTTP request.
 * Throwing makes the queue retry with backoff; returning marks the webhook-id processed.
 */
export async function handleWebhookJob(job: Job, deps: WebhookDeps): Promise<void> {
  const { store, client } = deps;
  const env = job.payload as WebhookEnvelope;
  const event = env.event ?? job.event;
  const rec = locate(store, env);
  const log = deps.log ?? (() => {});

  if (event.startsWith("bot.")) {
    const status = BOT_STATUS[event];
    const subCode = env.data?.data?.sub_code ?? null;
    if (rec) {
      store.update(rec.id, { ...(status ? { status } : {}), statusSubCode: subCode, ...(env.data?.bot?.id ? { botId: env.data.bot.id } : {}) }, event);
    }
    log({ event, meeting: rec?.id ?? null, subCode });
    return;
  }

  if (event === "recording.done") {
    const recordingId = env.data?.recording?.id;
    if (!recordingId) throw new Error("recording.done without data.recording.id");
    if (rec) store.update(rec.id, { recordingId }, event);
    // Exactly one async transcript per recording: skip when we already started one.
    if (rec?.transcriptId) {
      log({ event, meeting: rec.id, skipped: "transcript_already_started" });
      return;
    }
    const transcript = await client.createTranscript(recordingId, deps.transcriptLanguage ?? "auto");
    if (rec) store.update(rec.id, { transcriptId: transcript.id, transcriptError: null }, "transcript.requested");
    log({ event, meeting: rec?.id ?? null, transcriptId: transcript.id });
    return;
  }

  if (event === "transcript.done") {
    const transcriptId = env.data?.transcript?.id;
    if (!transcriptId) throw new Error("transcript.done without data.transcript.id");
    const artifact = await client.retrieveTranscript(transcriptId);
    const url = artifact.data?.download_url;
    if (!url) throw new Error("transcript artifact has no download_url");
    const data = await client.downloadJson(url);
    const target = rec ?? store.byTranscript(transcriptId);
    if (target) {
      const text = toReadableTranscript(data);
      const paths = store.saveTranscript(target.id, data, text);
      store.update(target.id, { transcriptId, ...paths, transcriptError: null }, event);
      log({ event, meeting: target.id, transcriptId, bytes: text.length });
    } else {
      log({ event, meeting: null, transcriptId, note: "no matching meeting record" });
    }
    return;
  }

  if (event === "transcript.failed") {
    const subCode = env.data?.status?.sub_code ?? null;
    if (rec) store.update(rec.id, { transcriptError: subCode ?? "failed" }, event);
    log({ event, meeting: rec?.id ?? null, subCode });
    return;
  }

  log({ event, meeting: rec?.id ?? null, note: "unhandled event" });
}
