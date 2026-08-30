import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Meeting session registry + signed short-lived tokens (Round 3 Gate 5).
 *
 * Token = base64url(JSON payload) "." base64url(HMAC-SHA256(payload, secret)).
 * Payload: { sid (meetingSessionId), bot (botId or "" until bound), role, exp, iat, nonce, brk? (public broker URL) }
 * Roles:
 *   bot_page — embedded in the Output Media page URL Recall streams. ≤ 15 min, single activation (nonce replay → 401).
 *   relay    — Recall's realtime websocket endpoint URL. Bound to the session; checked on every message.
 *   client   — operator UI / bot page websocket + operator-only routes (refresh / revoke).
 * Every verification also checks the server-side registry: revoked / ended sessions and botId binding.
 */
export type MeetingTokenRole = "bot_page" | "relay" | "client";

export interface MeetingTokenPayload {
  sid: string;
  bot: string;
  role: MeetingTokenRole;
  exp: number;
  iat: number;
  nonce: string;
  brk?: string;
}

export interface MeetingSessionRecord {
  id: string;
  meetingUrl: string;
  botId: string | null;
  botName: string;
  mode: "output_media" | "relay";
  /** What the bot page should render — server-side so the URL query is never trusted. */
  botPageQuery: Record<string, string>;
  createdAt: number;
  lastActivityAt: number;
  revoked: boolean;
  ended: boolean;
  endReason?: string;
  /** Nonces already used (bot_page activation replay prevention). */
  usedNonces: Set<string>;
  /** Set on the first successful bot-page activation. */
  botPageActivatedAt: number | null;
  /** Bot page activations (1 expected; >1 means the URL leaked or was replayed after refresh). */
  activations: number;
  outputMediaRestarts: number;
}

export type VerifyFailure =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "wrong_role"
  | "unknown_session"
  | "revoked"
  | "ended"
  | "bot_mismatch"
  | "replayed";

export type VerifyResult = { ok: true; payload: MeetingTokenPayload; session: MeetingSessionRecord } | { ok: false; reason: VerifyFailure };

export const TOKEN_TTL_MS: Record<MeetingTokenRole, number> = {
  bot_page: 15 * 60_000,
  relay: 6 * 60 * 60_000,
  client: 60 * 60_000,
};

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

export class MeetingSessionRegistry {
  private sessions = new Map<string, MeetingSessionRecord>();
  readonly secretSource: "env" | "ephemeral";
  private readonly secret: Buffer;

  constructor(secret: string | undefined, private readonly now: () => number = Date.now, private readonly opts: { idleTtlMs?: number; endedTtlMs?: number } = {}) {
    if (secret && secret.length >= 16) {
      this.secret = Buffer.from(secret, "utf8");
      this.secretSource = "env";
    } else {
      this.secret = randomBytes(32);
      this.secretSource = "ephemeral";
    }
  }

  // ---- sessions -----------------------------------------------------------------------------------
  create(input: { meetingUrl: string; botName: string; mode: "output_media" | "relay"; botPageQuery?: Record<string, string> }): MeetingSessionRecord {
    const t = this.now();
    const rec: MeetingSessionRecord = {
      id: randomUUID(),
      meetingUrl: input.meetingUrl,
      botId: null,
      botName: input.botName,
      mode: input.mode,
      botPageQuery: { ...(input.botPageQuery ?? {}) },
      createdAt: t,
      lastActivityAt: t,
      revoked: false,
      ended: false,
      usedNonces: new Set(),
      botPageActivatedAt: null,
      activations: 0,
      outputMediaRestarts: 0,
    };
    this.sessions.set(rec.id, rec);
    return rec;
  }

  get(id: string): MeetingSessionRecord | undefined {
    return this.sessions.get(id);
  }

  /** Latest live session for a bot (falls back to the latest ended one). */
  byBot(botId: string): MeetingSessionRecord | undefined {
    const all = this.allByBot(botId);
    return all.find((s) => !s.ended && !s.revoked) ?? all[0];
  }

  allByBot(botId: string): MeetingSessionRecord[] {
    return [...this.sessions.values()].filter((s) => s.botId === botId).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Active (not ended/revoked) session for the same meeting URL — duplicate-join detection. */
  findActiveByMeetingUrl(meetingUrl: string): MeetingSessionRecord | undefined {
    const norm = normalizeMeetingUrl(meetingUrl);
    for (const s of this.sessions.values()) if (!s.ended && !s.revoked && normalizeMeetingUrl(s.meetingUrl) === norm) return s;
    return undefined;
  }

  bindBot(id: string, botId: string): void {
    const s = this.sessions.get(id);
    if (s) {
      s.botId = botId;
      s.lastActivityAt = this.now();
    }
  }

  touch(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastActivityAt = this.now();
  }

  revoke(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.revoked = true;
    return true;
  }

  /** Marks the session finished (bot left / done / fatal). Tokens stop verifying immediately. */
  end(id: string, reason: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.ended = true;
    s.endReason = reason;
    s.lastActivityAt = this.now();
    return true;
  }

  /** Removes ended sessions after `endedTtlMs` (5 min) and idle live sessions after `idleTtlMs` (6 h). Returns removed ids. */
  sweep(now: number = this.now()): string[] {
    const idle = this.opts.idleTtlMs ?? 6 * 60 * 60_000;
    const endedTtl = this.opts.endedTtlMs ?? 5 * 60_000;
    const removed: string[] = [];
    for (const [id, s] of this.sessions) {
      if ((s.ended || s.revoked) && now - s.lastActivityAt >= endedTtl) removed.push(id);
      else if (now - s.lastActivityAt >= idle) removed.push(id);
    }
    for (const id of removed) this.sessions.delete(id);
    return removed;
  }

  size(): number {
    return this.sessions.size;
  }

  // ---- tokens -------------------------------------------------------------------------------------
  issue(sessionId: string, role: MeetingTokenRole, opts: { ttlMs?: number; brokerPublicUrl?: string } = {}): string {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("unknown session");
    const ttl = Math.min(opts.ttlMs ?? TOKEN_TTL_MS[role], TOKEN_TTL_MS[role]);
    const t = this.now();
    const payload: MeetingTokenPayload = { sid: sessionId, bot: s.botId ?? "", role, exp: t + ttl, iat: t, nonce: randomBytes(12).toString("base64url") };
    if (opts.brokerPublicUrl) payload.brk = opts.brokerPublicUrl;
    const body = b64url(JSON.stringify(payload));
    return `${body}.${this.sign(body)}`;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }

  /** Signature + expiry + registry checks. `botId` (when given) must match the session's bound bot. */
  verify(token: string, expect: { role?: MeetingTokenRole | MeetingTokenRole[]; botId?: string; now?: number } = {}): VerifyResult {
    const now = expect.now ?? this.now();
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
    const [body, sig] = parts as [string, string];
    const expected = this.sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
    let payload: MeetingTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MeetingTokenPayload;
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (typeof payload.exp !== "number" || now >= payload.exp) return { ok: false, reason: "expired" };
    if (expect.role) {
      const roles = Array.isArray(expect.role) ? expect.role : [expect.role];
      if (!roles.includes(payload.role)) return { ok: false, reason: "wrong_role" };
    }
    const session = this.sessions.get(payload.sid);
    if (!session) return { ok: false, reason: "unknown_session" };
    if (session.revoked) return { ok: false, reason: "revoked" };
    if (session.ended) return { ok: false, reason: "ended" };
    if (expect.botId !== undefined && session.botId !== expect.botId) return { ok: false, reason: "bot_mismatch" };
    if (payload.bot && session.botId && payload.bot !== session.botId) return { ok: false, reason: "bot_mismatch" };
    return { ok: true, payload, session };
  }

  /** bot_page activation: verifies and burns the nonce (a second activation with the same token → replayed). */
  activateBotPage(token: string, now: number = this.now()): VerifyResult {
    const r = this.verify(token, { role: "bot_page", now });
    if (!r.ok) return r;
    if (r.session.usedNonces.has(r.payload.nonce)) return { ok: false, reason: "replayed" };
    r.session.usedNonces.add(r.payload.nonce);
    r.session.activations++;
    r.session.botPageActivatedAt = now;
    r.session.lastActivityAt = now;
    return r;
  }
}

export function normalizeMeetingUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Unsigned payload peek (for the bot page to learn its broker URL before verifying server-side). */
export function peekMeetingToken(token: string): MeetingTokenPayload | null {
  const body = token.split(".")[0];
  if (!body) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MeetingTokenPayload;
  } catch {
    return null;
  }
}
