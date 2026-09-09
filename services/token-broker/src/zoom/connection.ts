import { createHash, randomBytes } from "node:crypto";
import type { ZoomStore, ZoomRecord } from "./store.js";

export const digest = (value: string): string => createHash("sha256").update(value).digest("base64url");
const random = (): string => randomBytes(32).toString("base64url");
const valid = (value: unknown): value is string => typeof value === "string" && /^[\w-]{43}$/.test(value);
export class ZoomAuthError extends Error {
  constructor(readonly code: string, readonly status = 401) { super(code); }
}
export interface ZoomConnectionConfig {
  clientId: string;
  callbackUrl: string;
  webOrigin: string;
  attendeeKey: string;
  attendeeBase?: string;
}

/** Zoom authorization is the account boundary. No caller-selected Zoom user IDs are accepted. */
export class ZoomConnections {
  constructor(readonly config: ZoomConnectionConfig, private store: ZoomStore, private request: typeof fetch = fetch, private now = Date.now) {
    for (const url of [config.callbackUrl, config.webOrigin]) {
      if (new URL(url).protocol !== "https:") throw new Error("Zoom OAuth requires fixed HTTPS origins");
    }
    if (new URL(config.webOrigin).origin !== config.webOrigin) throw new Error("Zoom webOrigin must be an origin");
  }
  private async vendor(path: string, method = "GET", body?: unknown): Promise<ZoomRecord> {
    const response = await this.request(`${this.config.attendeeBase ?? "https://app.attendee.dev"}/api/v1/zoom_oauth_connections${path}`, {
      method, headers: { Authorization: `Token ${this.config.attendeeKey}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new ZoomAuthError(response.status === 404 ? "ZOOM_CONNECTION_REVOKED" : "ZOOM_PROVIDER_UNAVAILABLE", response.status === 404 ? 401 : 503);
    return method === "DELETE" || response.status === 204 ? {} : await response.json() as ZoomRecord;
  }
  async start(challenge: string): Promise<{ state: string; cookie: string; url: string }> {
    if (!valid(challenge)) throw new ZoomAuthError("INVALID_ZOOM_CHALLENGE", 400);
    const state = random(), cookie = random();
    await this.store.put(`flow_${digest(state)}`, { challenge, cookieHash: digest(cookie), status: "pending", expires: this.now() + 600000, expiresAt: new Date(this.now() + 600000) });
    const url = new URL("https://zoom.us/oauth/authorize");
    url.search = new URLSearchParams({ response_type: "code", client_id: this.config.clientId, redirect_uri: this.config.callbackUrl, state }).toString();
    return { state, cookie, url: url.href };
  }
  async callback(state: string, cookie: string, code: string, denied = false): Promise<void> {
    if (!valid(state) || !valid(cookie)) throw new ZoomAuthError("INVALID_ZOOM_STATE");
    const key = `flow_${digest(state)}`;
    await this.store.change(key, previous => {
      if (!previous || previous.status !== "pending" || Number(previous.expires) <= this.now() || previous.cookieHash !== digest(cookie)) throw new ZoomAuthError("INVALID_ZOOM_STATE");
      return { ...previous, status: denied ? "denied" : "exchanging" };
    });
    if (denied) throw new ZoomAuthError("ZOOM_AUTHORIZATION_DENIED", 400);
    if (!code || code.length > 4096) throw new ZoomAuthError("INVALID_ZOOM_CODE", 400);
    // Consumed before network I/O: neither a concurrent callback nor a retry exchanges the code twice.
    const connection = await this.vendor("", "POST", { authorization_code: code, redirect_uri: this.config.callbackUrl, is_local_recording_token_supported: false, is_onbehalf_token_supported: true });
    if (connection.state !== "connected" || typeof connection.id !== "string" || !/^zoc_[\w-]+$/.test(connection.id) || typeof connection.user_id !== "string" || !connection.user_id) throw new ZoomAuthError("ZOOM_CONNECTION_NOT_READY", 503);
    await this.store.change(key, previous => {
      if (!previous || previous.status !== "exchanging") throw new ZoomAuthError("INVALID_ZOOM_STATE");
      return { ...previous, status: "ready", connectionId: connection.id, zoomUserId: connection.user_id };
    });
  }
  async complete(state: string, verifier: string): Promise<string> {
    if (!valid(state) || !valid(verifier)) throw new ZoomAuthError("INVALID_ZOOM_STATE");
    const flow = await this.store.change(`flow_${digest(state)}`, previous => {
      if (!previous || previous.status !== "ready" || Number(previous.expires) <= this.now() || previous.challenge !== digest(verifier)) throw new ZoomAuthError("INVALID_ZOOM_STATE");
      return { ...previous, status: "redeemed" };
    });
    const account = digest(String(flow.zoomUserId)), token = random();
    const previous = await this.store.get(`user_${account}`);
    await this.store.put(`user_${account}`, { connectionId: flow.connectionId, zoomUserId: flow.zoomUserId });
    await this.store.put(`session_${digest(token)}`, { account, connectionId: flow.connectionId, expires: this.now() + 12 * 3600000, expiresAt: new Date(this.now() + 12 * 3600000) });
    if (previous?.connectionId && previous.connectionId !== flow.connectionId) {
      // Best effort cleanup of this same user's superseded connection. Never another account's.
      await this.vendor(`/${encodeURIComponent(String(previous.connectionId))}`, "DELETE").catch(() => {});
    }
    return token;
  }
  private async identity(token: string): Promise<{ account: string; connectionId: string }> {
    if (!valid(token)) throw new ZoomAuthError("ZOOM_LOGIN_REQUIRED");
    const session = await this.store.get(`session_${digest(token)}`);
    if (!session || Number(session.expires) <= this.now() || typeof session.account !== "string" || typeof session.connectionId !== "string") throw new ZoomAuthError("ZOOM_LOGIN_REQUIRED");
    return { account: session.account, connectionId: session.connectionId };
  }
  async status(token: string): Promise<{ connected: boolean; disconnectPending: boolean }> {
    const { account, connectionId } = await this.identity(token), user = await this.store.get(`user_${account}`);
    if (user?.revocationPending === connectionId) return { connected: false, disconnectPending: true };
    if (user?.connectionId !== connectionId) return { connected: false, disconnectPending: false };
    try { await this.authorize(token); return { connected: true, disconnectPending: false }; }
    catch (e) { if (e instanceof ZoomAuthError && e.status === 401) return { connected: false, disconnectPending: false }; throw e; }
  }
  async authorize(token: string): Promise<string> {
    const { account, connectionId } = await this.identity(token), user = await this.store.get(`user_${account}`);
    if (user?.connectionId !== connectionId || typeof user.zoomUserId !== "string") throw new ZoomAuthError("ZOOM_LOGIN_REQUIRED");
    const connection = await this.vendor(`/${encodeURIComponent(String(user.connectionId))}`);
    if (connection.state !== "connected" || connection.user_id !== user.zoomUserId) throw new ZoomAuthError("ZOOM_CONNECTION_REVOKED");
    // A concurrent disconnect must also close the new-join path.
    if ((await this.store.get(`user_${account}`))?.connectionId !== user.connectionId) throw new ZoomAuthError("ZOOM_CONNECTION_REVOKED");
    return user.zoomUserId;
  }
  async disconnect(token: string): Promise<void> {
    const { account, connectionId } = await this.identity(token);
    const revoked = await this.store.change(`user_${account}`, previous => {
      if (previous?.connectionId !== connectionId && previous?.revocationPending !== connectionId) throw new ZoomAuthError("ZOOM_LOGIN_REQUIRED");
      return { connectionId: null, revocationPending: connectionId };
    });
    if (revoked.revocationPending) {
      try { await this.vendor(`/${encodeURIComponent(String(revoked.revocationPending))}`, "DELETE"); }
      catch (e) { if (!(e instanceof ZoomAuthError) || e.code !== "ZOOM_CONNECTION_REVOKED") throw e; }
      await this.store.change(`user_${account}`, previous => {
        if (previous?.revocationPending !== revoked.revocationPending) return previous ?? {};
        return { ...previous, revocationPending: null };
      });
    }
  }
}
