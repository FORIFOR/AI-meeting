/**
 * Helpers for the page that runs INSIDE the Recall bot (Output Media mode).
 * The bot grants microphone access automatically (meeting audio) and exposes a transcript websocket.
 * docs: https://docs.recall.ai/docs/stream-media
 */
export const RECALL_BOT_TRANSCRIPT_WS = "wss://meeting-data.bot.recall.ai/api/v1/transcript";

export interface BotPageParams {
  /** Signed single-use session token (Round 3 Gate 5). Everything else is fetched from the broker after activation. */
  token: string;
  /** Broker public URL peeked from the (unverified) token payload — the broker verifies the signature. */
  brokerUrl?: string;
  /** Legacy/dev fields (unsigned query) — ignored when a token is present. */
  botId?: string;
  characterId?: string;
  personaId?: string;
  engine?: string;
  displayName?: string;
  proactivity?: string;
  language?: string;
}

export const BOT_PAGE_FLAG = "rcai_bot";

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  if (typeof atob === "function") return atob(b64);
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Unverified peek at the token payload (sid/bot/brk). Never trust it for authorization — the broker verifies. */
export function peekBotPageToken(token: string): { sid?: string; bot?: string; role?: string; exp?: number; brk?: string } | null {
  const body = token.split(".")[0];
  if (!body) return null;
  try {
    return JSON.parse(b64urlDecode(body)) as { sid?: string; bot?: string; role?: string; exp?: number; brk?: string };
  } catch {
    return null;
  }
}

/** Parses `?rcai_bot=1&token=…` from the current location (returns null when not running as a bot page). */
export function parseBotPageParams(search: string): BotPageParams | null {
  const q = new URLSearchParams(search);
  if (q.get(BOT_PAGE_FLAG) !== "1") return null;
  const token = q.get("token") ?? "";
  const peek = token ? peekBotPageToken(token) : null;
  return {
    token,
    brokerUrl: peek?.brk,
    botId: q.get("botId") ?? peek?.bot ?? undefined,
    characterId: q.get("character") ?? undefined,
    personaId: q.get("persona") ?? undefined,
    engine: q.get("engine") ?? undefined,
    displayName: q.get("name") ?? undefined,
    proactivity: q.get("proactivity") ?? undefined,
    language: q.get("language") ?? undefined,
  };
}

export class BotPageActivationError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`BOT_PAGE_ACTIVATION_${status}:${reason}`);
    this.name = "BotPageActivationError";
  }
}

/**
 * Bot page → broker: `POST /api/meeting/session/activate { token }`. Burns the single-use token and returns the
 * server-held render config (character/persona/engine/name) + a client websocket URL/token.
 * 401 (expired / replayed / revoked / bad signature) throws BotPageActivationError — the page must not start.
 */
export async function activateBotPage(brokerUrl: string, token: string, fetchImpl: typeof fetch = fetch): Promise<import("./protocol.js").ActivateBotPageResponse> {
  const res = await fetchImpl(`${brokerUrl.replace(/\/$/, "")}/api/meeting/session/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new BotPageActivationError(res.status, body.detail ?? body.error ?? String(res.status));
  }
  return (await res.json()) as import("./protocol.js").ActivateBotPageResponse;
}

export interface BotTranscriptEvent {
  text: string;
  final: boolean;
  speakerName: string | null;
  participantId?: string;
}

/**
 * Connects to the in-bot transcript feed. Messages have the same shape as the `data` object of
 * real-time transcription events: `{ transcript: { words: [...], participant: {...} } }` (partial vs final is
 * indicated by the presence of `is_final`/event name in some versions; we treat every message as final unless
 * `partial` is flagged).
 */
export function connectBotTranscript(onEvent: (e: BotTranscriptEvent) => void, wsFactory: (url: string) => WebSocket = (u) => new WebSocket(u)): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  const open = () => {
    if (closed) return;
    ws = wsFactory(RECALL_BOT_TRANSCRIPT_WS);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { event?: string; transcript?: { words?: { text: string }[]; participant?: { id?: number; name?: string | null }; is_final?: boolean }; data?: { words?: { text: string }[]; participant?: { id?: number; name?: string | null } } };
        const t = msg.transcript ?? msg.data;
        const words = t?.words ?? [];
        if (!words.length) return;
        const text = words.map((w) => w.text).join(" ").replace(/([぀-ヿ一-鿿])\s+(?=[぀-ヿ一-鿿])/g, "$1").trim();
        const partial = msg.event === "transcript.partial_data" || (msg.transcript && msg.transcript.is_final === false);
        onEvent({ text, final: !partial, speakerName: t?.participant?.name ?? null, participantId: t?.participant?.id !== undefined ? String(t.participant.id) : undefined });
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
