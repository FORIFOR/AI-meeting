import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BrokerEnv {
  PORT?: string;
  /** Container deployments bind 0.0.0.0; local development defaults to loopback. */
  HOST?: string;
  /** Must match VITE_RCAI_RELEASE_CHANNEL. Unverified features never open on public. */
  RCAI_RELEASE_CHANNEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_REALTIME_MODEL?: string;
  OPENAI_PLAN_MODEL?: string;
  OPENAI_EVAL_MODEL?: string;
  GEMINI_BACKEND?: "developer" | "vertex";
  GOOGLE_CLOUD_PROJECT?: string;
  GOOGLE_CLOUD_LOCATION?: string;
  VERTEX_LIVE_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_LIVE_MODEL?: string;
  /** Attendee API base; supports hosted and self-hosted deployments. */
  ATTENDEE_API_BASE_URL?: string;
  GEMINI_EVAL_MODEL?: string;
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  HEYGEN_API_KEY?: string;
  HEYGEN_AVATAR_ID?: string;
  HEYGEN_VOICE_ID?: string;
  TAVUS_API_KEY?: string;
  TAVUS_REPLICA_ID?: string;
  TAVUS_PERSONA_ID?: string;
  /** Recall.ai meeting bots (P0-1). */
  RECALL_API_KEY?: string;
  RECALL_REGION?: string;
  /** Public https base URL of this broker (tunnel) so Recall can open the realtime relay websocket. */
  RECALL_PUBLIC_URL?: string;
  /** Public URL of the web app; the bot streams it as its camera/audio in output_media mode. */
  RECALL_BOT_PAGE_URL?: string;
  /**
   * Workspace verification secret (whsec_…) for dashboard webhooks, realtime endpoints and callbacks.
   * `get_info` reports which source a workspace uses; NEXT-STANDARDS uses the workspace secret.
   */
  RECALL_WEBHOOK_VERIFICATION_SECRET?: string;
  /** Display name of the meeting bot (calendar-scheduled bots reuse it). */
  RECALL_BOT_NAME?: string;
  /** Output Media bot variant. Defaults to `web_gpu` — the only variant with WebGL, which Live2D needs. */
  RECALL_BOT_VARIANT?: string;
  /** Google login group for authenticated Meet bots — required by meetings that refuse anonymous joins. */
  RECALL_GOOGLE_LOGIN_GROUP_ID?: string;
  /** What the bot posts in the meeting chat on join; "off" to send nothing (not recommended). */
  RECALL_JOIN_NOTICE?: string;
  /** Output Audio is a transport test, not the conversational path. "1" re-enables the endpoint. */
  RECALL_ALLOW_OUTPUT_AUDIO?: string;
  /** Guards the diagnostic bot GET and manual reconcile so they stay out of the product path. */
  RECALL_ADMIN_TOKEN?: string;
  /** Attendee (app.attendee.dev) — the second meeting provider. */
  ATTENDEE_API_KEY?: string;
  /** "off" to send the Attendee bot in without the avatar page (audio only). */
  ATTENDEE_VOICE_AGENT?: string;
  /** Signs Attendee webhooks; without it deliveries are recorded as unverified. */
  ATTENDEE_WEBHOOK_SECRET?: string;
  /**
   * Public URL of services/agent. Recall blocks localhost from the Output Media process, so a bot page
   * cannot reach the loopback agent the operator UI uses — without this the meeting audio arrives but
   * never reaches STT/LLM/TTS and the character stays silent.
   */
  RECALL_AGENT_PUBLIC_URL?: string;
  /** Language passed to async transcription ("auto" lets Recall detect it). */
  RECALL_TRANSCRIPT_LANGUAGE?: string;
  /** Override the durable store/queue directory (tests). */
  RECALL_DATA_DIR?: string;
  /**
   * Calendar V2: the `regional_callback_uri` returned by `start_calendar_integration_setup`.
   * Our customer-owned callback forwards `state`/`code`/`error`/`recall_calendar_setup_probe` there.
   */
  RECALL_CALENDAR_REGIONAL_CALLBACK_URI?: string;
  /** How often to inject the full bot config for imminent calendar bookings (ms). */
  RECALL_CALENDAR_ARM_INTERVAL_MS?: string;
  /** HMAC secret (≥16 chars) for meeting session tokens; an ephemeral secret is generated when unset (tokens die with the process). */
  MEETING_TOKEN_SECRET?: string;
}

/** Minimal .env parser (no dependency). process.env wins over the file. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function loadEnv(): BrokerEnv {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "../.env"), resolve(process.cwd(), ".env")];
  const fromFile: Record<string, string> = {};
  for (const p of candidates) {
    if (existsSync(p)) Object.assign(fromFile, parseDotenv(readFileSync(p, "utf8")));
  }
  const merged: Record<string, string | undefined> = { ...fromFile };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && v !== "") merged[k] = v;
  // Empty strings in .env mean "unset".
  for (const k of Object.keys(merged)) if (merged[k] === "") delete merged[k];
  return merged as BrokerEnv;
}
