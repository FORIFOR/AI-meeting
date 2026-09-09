import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { ZoomConnections, digest } from "./connection.js";
import { registerZoomRoutes } from "./routes.js";
import type { ZoomStore, ZoomRecord } from "./store.js";

class MemoryStore implements ZoomStore {
  data = new Map<string, ZoomRecord>();
  async get(key: string) { return this.data.get(key) ?? null; }
  async put(key: string, value: ZoomRecord) { this.data.set(key, value); }
  async change(key: string, fn: (v: ZoomRecord | null) => ZoomRecord) {
    const value = fn(this.data.get(key) ?? null); this.data.set(key, value); return value;
  }
}
function fixture() {
  let now = 1000, exchanges = 0, failDelete = false;
  const connections = new Map<string, ZoomRecord>(), deleted: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const id = String(input).split("/").at(-1)!;
    if (init?.method === "POST") {
      exchanges++;
      const b = JSON.parse(String(init.body));
      expect(b.redirect_uri).toBe("https://broker.test/api/zoom/callback");
      expect(b.is_onbehalf_token_supported).toBe(true);
      expect(b.is_local_recording_token_supported).toBe(false);
      const connection = { id: `zoc_${exchanges}`, user_id: b.authorization_code, state: "connected" };
      connections.set(connection.id, connection); return Response.json(connection);
    }
    if (init?.method === "DELETE") {
      if (failDelete) return new Response("upstream failed", { status: 503 });
      deleted.push(id); connections.delete(id); return new Response(null, { status: 204 });
    }
    return connections.has(id) ? Response.json(connections.get(id)) : new Response("missing", { status: 404 });
  };
  const store = new MemoryStore();
  const zoom = new ZoomConnections({ clientId: "client", callbackUrl: "https://broker.test/api/zoom/callback", webOrigin: "https://web.test", attendeeKey: "secret" }, store, fetcher as typeof fetch, () => now);
  const start = async () => { const verifier = randomBytes(32).toString("base64url"); return { ...await zoom.start(digest(verifier)), verifier }; };
  const login = async (user: string) => { const f = await start(); await zoom.callback(f.state, f.cookie, user); return zoom.complete(f.state, f.verifier); };
  return { store, zoom, start, login, connections, deleted, exchanges: () => exchanges, advance: (ms: number) => { now += ms; }, failDelete: (v: boolean) => { failDelete = v; } };
}

describe("Zoom account isolation and OAuth replay protection", () => {
  it("binds the callback to its initiating browser cookie and completion to its verifier", async () => {
    const f = fixture(), flow = await f.start();
    await expect(f.zoom.callback(flow.state, "x".repeat(43), "alice")).rejects.toThrow("INVALID_ZOOM_STATE");
    expect(f.exchanges()).toBe(0);
    await f.zoom.callback(flow.state, flow.cookie, "alice");
    await expect(f.zoom.complete(flow.state, "x".repeat(43))).rejects.toThrow("INVALID_ZOOM_STATE");
    const token = await f.zoom.complete(flow.state, flow.verifier);
    expect(await f.zoom.authorize(token)).toBe("alice");
    expect(JSON.stringify([...f.store.data.values()])).not.toContain(token);
    await expect(f.zoom.callback(flow.state, flow.cookie, "mallory")).rejects.toThrow("INVALID_ZOOM_STATE");
    await expect(f.zoom.complete(flow.state, flow.verifier)).rejects.toThrow("INVALID_ZOOM_STATE");
  });
  it("allows only one concurrent callback and one concurrent completion", async () => {
    const f = fixture(), flow = await f.start();
    const callbacks = await Promise.allSettled([f.zoom.callback(flow.state, flow.cookie, "alice"), f.zoom.callback(flow.state, flow.cookie, "alice")]);
    expect(callbacks.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(f.exchanges()).toBe(1);
    const completions = await Promise.allSettled([f.zoom.complete(flow.state, flow.verifier), f.zoom.complete(flow.state, flow.verifier)]);
    expect(completions.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("rejects expired authorization, denied authorization and expired application sessions", async () => {
    const f = fixture(), expired = await f.start(); f.advance(600001);
    await expect(f.zoom.callback(expired.state, expired.cookie, "alice")).rejects.toThrow("INVALID_ZOOM_STATE");
    const denied = await f.start(); await expect(f.zoom.callback(denied.state, denied.cookie, "", true)).rejects.toThrow("ZOOM_AUTHORIZATION_DENIED");
    await expect(f.zoom.callback(denied.state, denied.cookie, "alice")).rejects.toThrow("INVALID_ZOOM_STATE");
    const token = await f.login("alice"); f.advance(12 * 3600000);
    await expect(f.zoom.authorize(token)).rejects.toThrow("ZOOM_LOGIN_REQUIRED");
  });
  it("disconnects only the authenticated account and detects upstream revocation before a join", async () => {
    const f = fixture(), alice = await f.login("alice"), bob = await f.login("bob");
    await f.zoom.disconnect(alice);
    expect(f.deleted).toEqual(["zoc_1"]);
    await expect(f.zoom.authorize(alice)).rejects.toThrow("ZOOM_LOGIN_REQUIRED");
    expect(await f.zoom.authorize(bob)).toBe("bob");
    f.connections.set("zoc_2", { id: "zoc_2", user_id: "bob", state: "disconnected" });
    await expect(f.zoom.authorize(bob)).rejects.toThrow("ZOOM_CONNECTION_REVOKED");
  });
  it("keeps joins blocked and permits retry if remote revocation fails", async () => {
    const f = fixture(), token = await f.login("alice"); f.failDelete(true);
    await expect(f.zoom.disconnect(token)).rejects.toThrow("ZOOM_PROVIDER_UNAVAILABLE");
    await expect(f.zoom.authorize(token)).rejects.toThrow("ZOOM_LOGIN_REQUIRED");
    expect(await f.zoom.status(token)).toEqual({ connected: false, disconnectPending: true });
    f.failDelete(false); await f.zoom.disconnect(token); expect(f.deleted).toEqual(["zoc_1"]);
  });
  it("rejects a provider connection that belongs to a different user", async () => {
    const f = fixture(), token = await f.login("alice");
    f.connections.set("zoc_1", { id: "zoc_1", user_id: "bob", state: "connected" });
    await expect(f.zoom.authorize(token)).rejects.toThrow("ZOOM_CONNECTION_REVOKED");
  });
  it("sets secure browser binding, keeps credentials out of redirects, and checks completion origin", async () => {
    const f = fixture(), app = new Hono(); registerZoomRoutes(app, f.zoom);
    const verifier = randomBytes(32).toString("base64url");
    const response = await app.request(`https://broker.test/api/zoom/connect?challenge=${digest(verifier)}`);
    expect(response.status).toBe(302);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=Lax");
    const location = new URL(response.headers.get("location")!); const state = location.searchParams.get("state")!;
    expect(location.searchParams.get("redirect_uri")).toBe("https://broker.test/api/zoom/callback");
    const missing = await app.request(`https://broker.test/api/zoom/callback?state=${state}&code=alice`);
    expect(missing.status).toBe(401);
    const callback = await app.request(`https://broker.test/api/zoom/callback?state=${state}&code=alice`, { headers: { Cookie: cookie.split(";")[0]! } });
    expect(callback.headers.get("location")).toBe(`https://web.test/#zoom_oauth=${state}`);
    expect(callback.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify({ state, verifier });
    expect((await app.request("https://broker.test/api/zoom/complete", { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" }, body })).status).toBe(403);
    const complete = await app.request("https://broker.test/api/zoom/complete", { method: "POST", headers: { Origin: "https://web.test", "Content-Type": "application/json" }, body });
    expect(complete.status).toBe(200); expect(await complete.json()).toHaveProperty("token");
  });
});

it("derives the Zoom join identity from authorization and ignores a caller-selected identity", async () => {
  const { createApp } = await import("../app.js");
  const f = fixture(), token = await f.login("alice"), bodies: ZoomRecord[] = [];
  const app = createApp({ env: { ATTENDEE_API_KEY: "key", RECALL_PUBLIC_URL: "https://broker.test", ZOOM_REQUIRE_AUTH: "1" }, zoom: f.zoom, startWorker: false,
    fetch: (async (_input: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ id: "bot_test", state: "joining" }); }) as typeof fetch,
  });
  const body = JSON.stringify({ meetingUrl: "https://zoom.us/j/123", zoomUserId: "bob", zoom_settings: { onbehalf_token: { zoom_oauth_connection_user_id: "bob" } } });
  const anon = await app.request("/api/meeting/attendee/bots", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  expect(anon.status).toBe(401); expect(bodies).toHaveLength(0);
  const res = await app.request("/api/meeting/attendee/bots", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
  expect(res.status).toBe(200);
  expect(bodies[0]?.zoom_settings).toEqual({ sdk: "web", onbehalf_token: { zoom_oauth_connection_user_id: "alice" } });
});
