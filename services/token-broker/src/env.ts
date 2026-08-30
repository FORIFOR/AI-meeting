import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BrokerEnv {
  PORT?: string;
  OPENAI_API_KEY?: string;
  OPENAI_REALTIME_MODEL?: string;
  OPENAI_PLAN_MODEL?: string;
  OPENAI_EVAL_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_LIVE_MODEL?: string;
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
