import crypto from "node:crypto";

/**
 * Verify webhooks, realtime webhook posts, websocket upgrades and callbacks from Recall.ai.
 * Algorithm per docs.recall.ai/docs/authenticating-requests-from-recallai:
 *   headers: webhook-id / webhook-timestamp / webhook-signature   (svix-* accepted for legacy)
 *   key     = base64decode(secret without the "whsec_" prefix)
 *   toSign  = `${id}.${timestamp}.${rawBody}`   (rawBody = "" for GET/UPGRADE)
 *   sig     = base64(HMAC-SHA256(key, toSign)), compared timing-safely against every `v1,<sig>`
 *
 * Never log the headers, the body, or the secret. Callers log only the outcome.
 */

export class RecallVerificationError extends Error {
  constructor(readonly reason: "missing_secret" | "missing_headers" | "no_matching_signature" | "stale_timestamp") {
    super(reason);
    this.name = "RecallVerificationError";
  }
}

export interface VerifyArgs {
  secret: string;
  headers: Record<string, string | undefined>;
  /** Raw body exactly as received, or null for requests without one. */
  payload: string | null;
  /** Reject timestamps further than this from now (0 disables). Default 5 min, as Svix does. */
  toleranceSeconds?: number;
  now?: () => number;
}

export function verifyRequestFromRecall(args: VerifyArgs): void {
  const { secret, headers, payload } = args;
  const h = (name: string, legacy: string) => headers[name] ?? headers[legacy];
  const msgId = h("webhook-id", "svix-id");
  const msgTimestamp = h("webhook-timestamp", "svix-timestamp");
  const msgSignature = h("webhook-signature", "svix-signature");

  if (!secret || !secret.startsWith("whsec_")) throw new RecallVerificationError("missing_secret");
  if (!msgId || !msgTimestamp || !msgSignature) throw new RecallVerificationError("missing_headers");

  const tolerance = args.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const ts = Number(msgTimestamp);
    const now = Math.floor((args.now ?? Date.now)() / 1000);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) throw new RecallVerificationError("stale_timestamp");
  }

  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const toSign = `${msgId}.${msgTimestamp}.${payload ?? ""}`;
  const expected = crypto.createHmac("sha256", key).update(toSign).digest("base64");
  const expectedBytes = Buffer.from(expected, "base64");

  for (const versioned of msgSignature.split(" ")) {
    const [version, signature] = versioned.split(",");
    if (version !== "v1" || !signature) continue;
    const sigBytes = Buffer.from(signature, "base64");
    if (sigBytes.length === expectedBytes.length && crypto.timingSafeEqual(new Uint8Array(expectedBytes), new Uint8Array(sigBytes))) return;
  }
  throw new RecallVerificationError("no_matching_signature");
}

/** Sign a payload the way Recall does — used by the smoke script and the tests, never in production paths. */
export function signLikeRecall(secret: string, id: string, timestamp: string, payload: string | null): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${payload ?? ""}`).digest("base64")}`;
}

/** Lower-cased header map from a Hono/Fetch Request. */
export function headerMap(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}
