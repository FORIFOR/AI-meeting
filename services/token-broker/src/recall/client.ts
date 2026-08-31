import type { BrokerEnv } from "../env.js";

/**
 * One region-bound Recall.ai API client. Every route goes through this so the region, auth header,
 * retry policy and redaction rules exist in exactly one place.
 *
 * Verified against docs (workspace NEXT-STANDARDS, API v1.11, ap-northeast-1):
 *   POST   /api/v1/bot/                              create bot (meeting_url, bot_name, join_at, recording_config, output_media, metadata)
 *   GET    /api/v1/bot/{id}/                         retrieve bot (status_changes, recordings[])
 *   POST   /api/v1/bot/{id}/leave_call/              leave
 *   POST   /api/v1/recording/{id}/create_transcript/ async transcript {provider:{recallai_async:{language_code}},diarization:{...}}
 *   GET    /api/v1/transcript/{id}/                  retrieve transcript → data.download_url
 * Auth header is the raw key (no "Bearer"). 429 honours Retry-After; 503/507 back off with jitter.
 */

export class RecallConfigError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RecallConfigError";
  }
}

export class RecallApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** Response body, truncated. Never contains our credentials (Recall echoes request fields only). */
    readonly detail: string,
  ) {
    super(detail ? `recall ${status} ${path} ${detail}` : `recall ${status} ${path}`);
    this.name = "RecallApiError";
  }
}

export interface RecallClientOptions {
  apiKey: string;
  region: string;
  fetchImpl?: typeof fetch;
  /** Sleep hook so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Deterministic jitter in tests. */
  random?: () => number;
  maxRetries?: number;
}

export interface CreateBotRequest {
  meeting_url: string;
  bot_name?: string;
  /** ISO-8601. Scheduling path — set even for immediate joins when the caller knows the time. */
  join_at?: string;
  recording_config?: Record<string, unknown>;
  output_media?: Record<string, unknown>;
  /** Non-secret only: our meeting record id, app tag, mode. */
  metadata?: Record<string, string>;
}

export interface RecallBot {
  id: string;
  meeting_url?: unknown;
  status_changes?: { code: string; sub_code?: string | null; created_at?: string }[];
  recordings?: { id: string; media_shortcuts?: Record<string, unknown> }[];
  metadata?: Record<string, string>;
}

export interface RecallTranscript {
  id: string;
  status?: { code?: string; sub_code?: string | null };
  data?: { download_url?: string; provider_data_download_url?: string };
}

const RETRY_STATUS = new Set([429, 503, 507]);

export class RecallClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxRetries: number;

  constructor(private readonly opts: RecallClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  get region(): string {
    return this.opts.region;
  }

  get base(): string {
    return `https://${this.opts.region}.recall.ai/api/v1`;
  }

  /** Never logs or returns the key; used only to build the header. */
  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Authorization: this.opts.apiKey, accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 60_000));
    }
    const base = Math.min(2 ** attempt * 500, 16_000);
    return Math.round(base * (0.5 + this.random() * 0.5));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastDetail = "";
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      lastDetail = (await res.text().catch(() => "")).slice(0, 400);
      if (!RETRY_STATUS.has(res.status) || attempt === this.maxRetries) {
        throw new RecallApiError(res.status, path, lastDetail);
      }
      await this.sleep(this.backoffMs(attempt, res.headers.get("retry-after")));
    }
    throw new RecallApiError(0, path, lastDetail);
  }

  createBot(req: CreateBotRequest): Promise<RecallBot> {
    return this.request<RecallBot>("POST", "/bot/", req);
  }

  retrieveBot(botId: string): Promise<RecallBot> {
    return this.request<RecallBot>("GET", `/bot/${encodeURIComponent(botId)}/`);
  }

  leaveCall(botId: string): Promise<unknown> {
    return this.request<unknown>("POST", `/bot/${encodeURIComponent(botId)}/leave_call/`);
  }

  /**
   * Post-meeting transcription (guide: only after a verified `recording.done`).
   * A recording allows at most 10 live / 100 attempted transcripts — callers must not loop.
   */
  createTranscript(recordingId: string, languageCode = "auto"): Promise<RecallTranscript> {
    return this.request<RecallTranscript>("POST", `/recording/${encodeURIComponent(recordingId)}/create_transcript/`, {
      provider: { recallai_async: { language_code: languageCode } },
      diarization: { use_separate_streams_when_available: true },
    });
  }

  retrieveTranscript(transcriptId: string): Promise<RecallTranscript> {
    return this.request<RecallTranscript>("GET", `/transcript/${encodeURIComponent(transcriptId)}/`);
  }

  /** Expiring S3-style download URL from the transcript artifact — no auth header, no retry-on-4xx. */
  async downloadJson<T = unknown>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, { method: "GET" });
    if (!res.ok) throw new RecallApiError(res.status, "transcript.download_url", (await res.text().catch(() => "")).slice(0, 200));
    return (await res.json()) as T;
  }
}

/** Build the client from broker env; throws a BLOCKED_BY_* style error when a credential is missing. */
export function recallClientFromEnv(env: BrokerEnv, fetchImpl?: typeof fetch): RecallClient {
  if (!env.RECALL_API_KEY) throw new RecallConfigError("BLOCKED_BY_RECALL_KEY", "set RECALL_API_KEY in services/token-broker/.env");
  return new RecallClient({ apiKey: env.RECALL_API_KEY, region: env.RECALL_REGION ?? "us-west-2", fetchImpl });
}
