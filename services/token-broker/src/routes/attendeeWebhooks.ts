import { createHmac, timingSafeEqual } from "node:crypto";
import type { BrokerEnv } from "../env.js";
import type { MeetingStore } from "../recall/store.js";
import { shouldApplyStatus } from "../recall/botState.js";

/**
 * Attendee's outbound webhooks — the only thing that moves an Attendee meeting's state.
 *
 * Signature: `X-Webhook-Signature` is base64(HMAC-SHA256(canonical JSON, secret)), where canonical means
 * `json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))`. Attendee signs a
 * re-serialisation rather than the bytes it sent, so verification has to rebuild that exact string —
 * recursively sorted keys, no spaces, non-ASCII left alone.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

export function verifyAttendeeSignature(payload: unknown, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(canonicalJson(payload), "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Attendee state → the meeting record's vocabulary, so one screen can show either provider. */
const STATE_TO_STATUS: Record<string, string> = {
  scheduled: "creating",
  staged: "creating",
  ready: "creating",
  joining: "joining_call",
  joining_breakout_room: "joining_call",
  waiting_room: "in_waiting_room",
  joined_not_recording: "in_call_not_recording",
  joined_recording: "in_call_recording",
  joined_recording_paused: "in_call_recording",
  leaving: "call_ended",
  post_processing: "call_ended",
  ended: "done",
  fatal_error: "fatal",
  data_deleted: "done",
};

export interface AttendeeWebhookEnvelope {
  trigger?: string;
  bot_id?: string;
  data?: { new_state?: string; old_state?: string; event_type?: string; event_sub_type?: string | null; created_at?: string };
}

export interface AttendeeWebhookDeps {
  store: MeetingStore;
  log?: (line: Record<string, unknown>) => void;
  onBotStatus?: (s: { botId: string; status: string; subCode: string | null }) => void;
  /** Called once, the first time the bot is actually in the call, to tell participants what is happening. */
  onJoined?: (botId: string) => void;
}

const announced = new Set<string>();

export function handleAttendeeWebhook(env: AttendeeWebhookEnvelope, deps: AttendeeWebhookDeps): { ok: true; applied: boolean; reason: string } {
  const botId = env.bot_id ?? "";
  const log = deps.log ?? (() => {});
  if (env.trigger !== "bot.state_change" || !botId) {
    log({ at: "attendee.webhook", trigger: env.trigger, botId, applied: false, reason: "ignored" });
    return { ok: true, applied: false, reason: "ignored" };
  }
  const state = env.data?.new_state ?? "";
  const status = STATE_TO_STATUS[state];
  const subCode = env.data?.event_sub_type ?? null;
  const rec = deps.store.list(200).find((m) => m.botId === botId);
  const apply = Boolean(status) && Boolean(rec) && shouldApplyStatus(rec!.status, status!);
  if (rec && status) {
    deps.store.update(rec.id, apply ? { status: status as never, statusSubCode: subCode } : {}, apply ? `attendee.${state}` : `attendee.${state}:skipped`);
  }
  if (status) deps.onBotStatus?.({ botId, status, subCode });
  if ((state === "joined_recording" || state === "joined_not_recording") && !announced.has(botId)) {
    announced.add(botId);
    deps.onJoined?.(botId);
  }
  log({ at: "attendee.webhook", trigger: env.trigger, botId, state, status: status ?? null, subCode, meetingId: rec?.id ?? null, applied: apply });
  return { ok: true, applied: apply, reason: apply ? "applied" : "skipped" };
}

/**
 * What the bot says as it joins. Participants are entitled to know a machine is listening before it
 * does any listening; Meet asks humans for that consent and a bot should not be the exception.
 */
export async function sendAttendeeJoinNotice(brokerEnv: BrokerEnv, botId: string, fetchImpl: typeof fetch): Promise<boolean> {
  if (!brokerEnv.ATTENDEE_API_KEY || brokerEnv.RECALL_JOIN_NOTICE === "off") return false;
  const name = brokerEnv.RECALL_BOT_NAME ?? "Yui";
  const message = brokerEnv.RECALL_JOIN_NOTICE ??
    `${name}（AIアシスタント）が参加しました。この会議では AI による音声処理・文字起こし・議事録生成を行います。停止をご希望の場合は主催者にお知らせください。`;
  const res = await fetchImpl(`${(brokerEnv.ATTENDEE_API_BASE_URL ?? "https://app.attendee.dev").replace(/\/$/, "")}/api/v1/bots/${encodeURIComponent(botId)}/send_chat_message`, {
    method: "POST",
    headers: { Authorization: `Token ${brokerEnv.ATTENDEE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "everyone", message }),
  });
  return res.ok;
}

/** Test seam: the "announced once" set is process-wide. */
export function resetAttendeeAnnouncements(): void {
  announced.clear();
}
