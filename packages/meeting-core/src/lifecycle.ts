import type { MeetingStatus } from "./types.js";

/**
 * MeetingLifecycle (Round 3 Gate 5): pure state machine for a bot's life in a meeting.
 *
 *   created → joining → waiting_room → admitted ─┬→ reconnecting → admitted
 *                                  │             ├→ removed (host kicked)
 *                                  ├→ denied     ├→ ended (meeting over)
 *                                  └→ failed     ├→ left (we left)
 *                                                └→ failed (output media / reconnect timeout / fatal)
 * Vendor codes are mapped by `mapRecallStatus` (Recall.ai status + sub_code); other connectors map their own.
 */
export type LifecycleState = "created" | "joining" | "waiting_room" | "admitted" | "reconnecting" | "denied" | "removed" | "ended" | "left" | "failed";

export const TERMINAL_STATES: ReadonlySet<LifecycleState> = new Set(["denied", "removed", "ended", "left", "failed"]);

export type LifecycleEvent =
  | { type: "vendor_status"; state: LifecycleState; detail?: string }
  | { type: "relay_down" }
  | { type: "relay_up" }
  | { type: "host_mute"; muted: boolean }
  | { type: "output_media_failed"; detail?: string }
  | { type: "output_media_ok" }
  | { type: "leave" }
  | { type: "tick" };

export interface LifecycleTransition {
  from: LifecycleState;
  to: LifecycleState;
  reason: string;
  at: number;
}

export interface LifecycleOptions {
  /** Backoff base for relay reconnects (ms). Default 1000; doubles up to `reconnectMaxDelayMs`. */
  reconnectBaseMs?: number;
  reconnectMaxDelayMs?: number;
  /** Give up reconnecting after this long (ms). Default 60 000. */
  reconnectTimeoutMs?: number;
  /** How many output-media restarts before failing. Default 1. */
  outputMediaRetries?: number;
}

export interface LifecycleSnapshot {
  state: LifecycleState;
  audioMuted: boolean;
  /** True only while admitted, not muted and not reconnecting. */
  outboundAllowed: boolean;
  reconnectAttempt: number;
  outputMediaRetries: number;
  since: number;
  reason?: string;
}

export class MeetingLifecycle {
  private _state: LifecycleState = "created";
  private _muted = false;
  private since: number;
  private reason: string | undefined;
  private reconnectAttempt = 0;
  private reconnectStartedAt = 0;
  private outputRetries = 0;
  private history: LifecycleTransition[] = [];
  private listeners = new Set<(t: LifecycleTransition) => void>();
  private muteListeners = new Set<(muted: boolean, at: number) => void>();
  private readonly opts: Required<LifecycleOptions>;

  constructor(now: number, opts: LifecycleOptions = {}) {
    this.since = now;
    this.opts = {
      reconnectBaseMs: opts.reconnectBaseMs ?? 1000,
      reconnectMaxDelayMs: opts.reconnectMaxDelayMs ?? 8000,
      reconnectTimeoutMs: opts.reconnectTimeoutMs ?? 60_000,
      outputMediaRetries: opts.outputMediaRetries ?? 1,
    };
  }

  get state(): LifecycleState {
    return this._state;
  }

  get audioMuted(): boolean {
    return this._muted;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this._state);
  }

  get outboundAllowed(): boolean {
    return this._state === "admitted" && !this._muted;
  }

  snapshot(): LifecycleSnapshot {
    return { state: this._state, audioMuted: this._muted, outboundAllowed: this.outboundAllowed, reconnectAttempt: this.reconnectAttempt, outputMediaRetries: this.outputRetries, since: this.since, reason: this.reason };
  }

  onTransition(cb: (t: LifecycleTransition) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onMute(cb: (muted: boolean, at: number) => void): () => void {
    this.muteListeners.add(cb);
    return () => this.muteListeners.delete(cb);
  }

  getHistory(): LifecycleTransition[] {
    return [...this.history];
  }

  /** Delay before the next reconnect attempt (exponential backoff), or null when the budget is exhausted. */
  nextReconnectDelayMs(now: number): number | null {
    if (this._state !== "reconnecting") return null;
    if (now - this.reconnectStartedAt >= this.opts.reconnectTimeoutMs) return null;
    const d = Math.min(this.opts.reconnectMaxDelayMs, this.opts.reconnectBaseMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    return d;
  }

  /** Whether an output-media restart is still allowed (consumes one retry). */
  takeOutputMediaRetry(): boolean {
    if (this.outputRetries >= this.opts.outputMediaRetries) return false;
    this.outputRetries++;
    return true;
  }

  dispatch(event: LifecycleEvent, now: number): LifecycleTransition | null {
    const from = this._state;
    let to: LifecycleState | null = null;
    let reason: string = event.type;
    switch (event.type) {
      case "vendor_status": {
        reason = event.detail ? `${event.type}:${event.detail}` : event.type;
        if (TERMINAL_STATES.has(from) && !(from === "left" && false)) {
          // terminal states only accept a more specific terminal (e.g. ended after left is ignored)
          to = null;
          break;
        }
        if (event.state === "admitted" && from === "reconnecting") {
          to = "admitted";
          break;
        }
        if (event.state === from) break;
        // Do not regress from admitted to joining/waiting on stale polls.
        if (from === "admitted" && (event.state === "joining" || event.state === "waiting_room" || event.state === "created")) break;
        if (from === "reconnecting" && (event.state === "joining" || event.state === "waiting_room" || event.state === "created")) break;
        to = event.state;
        break;
      }
      case "relay_down":
        if (from === "admitted") {
          to = "reconnecting";
          this.reconnectAttempt = 0;
          this.reconnectStartedAt = now;
        }
        break;
      case "relay_up":
        if (from === "reconnecting") to = "admitted";
        break;
      case "tick":
        if (from === "reconnecting" && now - this.reconnectStartedAt >= this.opts.reconnectTimeoutMs) {
          to = "failed";
          reason = "reconnect_timeout";
        }
        break;
      case "host_mute": {
        if (this._muted !== event.muted) {
          this._muted = event.muted;
          for (const l of this.muteListeners) l(event.muted, now);
        }
        break;
      }
      case "output_media_failed":
        if (from === "admitted" || from === "reconnecting") {
          if (!this.takeOutputMediaRetry()) {
            to = "failed";
            reason = `output_media_failed${event.detail ? `:${event.detail}` : ""}`;
          } else {
            reason = `output_media_retry:${this.outputRetries}`;
          }
        }
        break;
      case "output_media_ok":
        break;
      case "leave":
        if (!TERMINAL_STATES.has(from)) {
          to = "left";
        }
        break;
    }
    if (to === null || to === from) return null;
    this._state = to;
    this.since = now;
    this.reason = reason;
    if (to !== "admitted" && to !== "reconnecting") this._muted = this._muted && !TERMINAL_STATES.has(to);
    const t: LifecycleTransition = { from, to, reason, at: now };
    this.history.push(t);
    if (this.history.length > 200) this.history.shift();
    for (const l of this.listeners) l(t);
    return t;
  }
}

/** Lifecycle state → public MeetingStatus. */
export function lifecycleToStatus(state: LifecycleState): MeetingStatus {
  switch (state) {
    case "created":
      return "created";
    case "joining":
      return "joining";
    case "waiting_room":
      return "waiting_room";
    case "admitted":
      return "in_call";
    case "reconnecting":
      return "reconnecting";
    case "denied":
      return "denied";
    case "removed":
      return "removed";
    case "ended":
      return "ended";
    case "left":
      return "left";
    case "failed":
      return "failed";
  }
}

const DENIED_CALL_ENDED = new Set(["bot_kicked_from_waiting_room", "timeout_exceeded_waiting_room", "call_ended_by_platform_waiting_room_timeout"]);
const DENIED_FATAL = new Set([
  "meeting_not_accessible", "meeting_requires_registration", "meeting_requires_sign_in", "meeting_locked", "meeting_full", "meeting_password_incorrect",
  "google_meet_knocking_disabled", "google_meet_bot_blocked", "google_meet_organisation_restricted", "google_meet_permission_denied_breakout", "google_meet_watermark_kicked",
  "zoom_bot_blocked", "zoom_account_blocked", "zoom_authorized_participants_only", "zoom_web_disallowed", "zoom_meeting_not_accessible", "zoom_email_blocked_by_admin",
  "microsoft_teams_bot_not_invited", "webex_service_app_unauthorized",
]);
const ENDED_CALL_ENDED_PREFIX = /^(call_ended_by_host|call_ended_by_platform_idle|call_ended_by_platform_max_length|timeout_exceeded_)/;

/**
 * Recall.ai `status.code` + `status.sub_code` → lifecycle state (docs.recall.ai/docs/bot-status-change-events, /docs/sub-codes).
 * Returns `null` for informational codes that do not change the lifecycle (breakout rooms, recording permission).
 */
export function mapRecallStatus(code: string, subCode?: string | null): { state: LifecycleState; detail: string } | null {
  const sub = subCode ?? "";
  const detail = sub ? `${code}/${sub}` : code;
  switch (code) {
    case "ready":
    case "scheduled":
      return { state: "created", detail };
    case "joining_call":
      return { state: "joining", detail };
    case "in_waiting_room":
      return { state: "waiting_room", detail };
    case "in_call_not_recording":
    case "in_call_recording":
    case "recording_permission_allowed":
    case "recording_permission_denied":
      return { state: "admitted", detail };
    case "call_ended":
      if (sub === "bot_kicked_from_call") return { state: "removed", detail };
      if (DENIED_CALL_ENDED.has(sub)) return { state: "denied", detail };
      if (sub === "bot_received_leave_call") return { state: "left", detail };
      if (!sub || ENDED_CALL_ENDED_PREFIX.test(sub) || sub === "meeting_not_started" || sub === "breakout_room_not_open") return { state: "ended", detail };
      return { state: "ended", detail };
    case "done":
      // Terminal bookkeeping after call_ended/fatal; no lifecycle change unless we never saw one.
      return null;
    case "fatal":
      if (sub === "meeting_ended") return { state: "ended", detail };
      if (DENIED_FATAL.has(sub)) return { state: "denied", detail };
      return { state: "failed", detail };
    default:
      return null; // breakout_room_*, unknown codes
  }
}
