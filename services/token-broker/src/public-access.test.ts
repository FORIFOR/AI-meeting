import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { publicDemoOnly, startsProviderWork } from "./public-access.js";
import { VertexLiveRelay } from "./vertex-live.js";

describe("public demo cost boundary", () => {
  it.each([
    ["POST", "/api/token/openai"], ["POST", "/api/token/gemini"], ["POST", "/api/session/openai-live"],
    ["POST", "/api/evaluate"], ["POST", "/api/plan"], ["POST", "/api/livekit/token"],
    ["POST", "/api/avatar/anam/session"], ["POST", "/api/avatar/heygen/session"], ["POST", "/api/avatar/tavus/conversation"],
    ["POST", "/api/meeting/attendee/bots"], ["POST", "/api/meeting/recall/bots"],
    ["POST", "/api/calendar/events/test/optin"], ["PUT", "/api/calendar/rule"],
    ["GET", "/api/meeting/calendar/oauth-callback"], ["POST", "/api/meeting/recall/bots/test/output_media/restart"],
  ])("rejects %s %s before parsing input or calling a provider", async (method, route) => {
    const upstream = vi.fn(() => { throw new Error("must not reach provider"); });
    const app = createApp({ env: { RCAI_PUBLIC_DEMO_ONLY: "1", OPENAI_API_KEY: "test-key", GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "test-project", ATTENDEE_API_KEY: "test-key" }, fetch: upstream, startWorker: false });
    const response = await app.request(route, { method, headers: { "content-type": "application/json", authorization: "Bearer arbitrary-caller-value" }, ...(method !== "GET" ? { body: "invalid JSON" } : {}) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "PUBLIC_DEMO_ONLY" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("advertises unavailable public cloud paths without removing configured keys", async () => {
    const env = { RCAI_PUBLIC_DEMO_ONLY: "1", OPENAI_API_KEY: "private-test-key", GEMINI_BACKEND: "vertex" as const, GOOGLE_CLOUD_PROJECT: "test-project", ATTENDEE_API_KEY: "private-test-key", RECALL_API_KEY: "private-test-key" };
    const app = createApp({ env, startWorker: false });
    const response = await app.request("/health");
    const health = await response.json();
    expect(response.status).toBe(200);
    expect(health.publicAccess).toEqual({ mode: "demo_only", reason: "PUBLIC_DEMO_ONLY" });
    expect(Object.values(health.providers).every(value => value === false)).toBe(true);
    expect(health.meeting).toMatchObject({ attendee: false, recall: false });
    expect(health.avatars.anam).toEqual({ configured: false, characterIds: [] });
    expect(JSON.stringify(health)).not.toContain("private-test-key");
    expect(env.OPENAI_API_KEY).toBe("private-test-key");
  });

  it("keeps cleanup reachable through the application router", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    const app = createApp({ env: { RCAI_PUBLIC_DEMO_ONLY: "1", ATTENDEE_API_KEY: "test-key" }, fetch: fetcher, startWorker: false });
    const leave = await app.request("/api/meeting/attendee/bots/bot_test/leave", { method: "POST" });
    expect(leave.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    const revoke = await app.request("/api/meeting/session/nonexistent/revoke", { method: "POST" });
    expect((await revoke.json()).error).not.toBe("PUBLIC_DEMO_ONLY");
    for (const route of ["/api/avatar/heygen/stop", "/api/meeting/recall/bots/test/leave", "/api/calendar/events/test/optout"]) {
      expect(startsProviderWork("POST", route)).toBe(false);
    }
  });

  it("preserves self-hosted behavior unless explicitly enabled", async () => {
    expect(publicDemoOnly({})).toBe(false);
    expect(publicDemoOnly({ RCAI_PUBLIC_DEMO_ONLY: "0" })).toBe(false);
    const upstream = vi.fn(async () => new Response(JSON.stringify({ value: "test-client-secret", expires_at: 1234 })));
    const app = createApp({ env: { OPENAI_API_KEY: "test-key" }, fetch: upstream, startWorker: false });
    expect((await app.request("/api/token/openai", { method: "POST", body: "{}" })).status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect((await (await app.request("/health")).json()).providers.openai).toBe(true);
  });

  it("refuses an already-issued Vertex ticket after public-demo mode is enabled", () => {
    const env = { GOOGLE_CLOUD_PROJECT: "test-project", MEETING_TOKEN_SECRET: "a-long-synthetic-test-secret", RCAI_PUBLIC_DEMO_ONLY: "0" };
    const relay = new VertexLiveRelay(env), ticket = relay.mint();
    env.RCAI_PUBLIC_DEMO_ONLY = "1";
    expect(relay.consume(ticket.token)).toBeNull();
  });
});
