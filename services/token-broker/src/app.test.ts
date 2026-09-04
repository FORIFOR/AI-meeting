import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { parseDotenv } from "./env.js";
import { MeetingSessionRegistry } from "./meeting-session.js";
import { RelayHub as RelayHubCls } from "./meeting-relay.js";

type Call = { url: string; init?: RequestInit };
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("token broker", () => {
  it("/health reports configured providers as booleans only", async () => {
    const app = createApp({ env: { OPENAI_API_KEY: "sk-test" } });
    const res = await app.request("/health");
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, providers: { openai: true, google: false, livekit: false, heygen: false, tavus: false, recall: false }, meeting: { recall: false, recallPublicUrl: false } });
    expect(JSON.stringify(json)).not.toContain("sk-test");
  });

  it("returns 503 BLOCKED_BY_* when keys are missing", async () => {
    const app = createApp({ env: {}, fetch: mockFetch(() => new Response("should not be called", { status: 500 })) });
    expect(await (await post(app, "/api/token/openai", {})).json()).toEqual({ error: "BLOCKED_BY_OPENAI_KEY" });
    expect((await post(app, "/api/token/openai", {})).status).toBe(503);
    expect(await (await post(app, "/api/token/gemini", {})).json()).toEqual({ error: "BLOCKED_BY_GEMINI_KEY" });
    expect(await (await post(app, "/api/livekit/token", { room: "r", identity: "i" })).json()).toEqual({ error: "BLOCKED_BY_LIVEKIT_KEY" });
    expect(await (await post(app, "/api/avatar/heygen/session", {})).json()).toEqual({ error: "BLOCKED_BY_HEYGEN_KEY" });
    expect(await (await post(app, "/api/avatar/tavus/conversation", {})).json()).toEqual({ error: "BLOCKED_BY_TAVUS_KEY" });
    expect((await post(app, "/api/evaluate", { providerId: "openai", input: { transcript: [] } })).status).toBe(503);
  });

  it("mints an OpenAI client secret with the GA session shape", async () => {
    const calls: Call[] = [];
    const app = createApp({
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: mockFetch(() => new Response(JSON.stringify({ value: "ek_abc", expires_at: 1756310470, session: { model: "gpt-realtime" } })), calls),
    });
    const res = await post(app, "/api/token/openai", { voice: "marin", instructions: "hi", language: "ja-JP" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientSecret: "ek_abc", expiresAt: 1756310470000, model: "gpt-realtime", baseUrl: "https://api.openai.com/v1/realtime" });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.session.type).toBe("realtime");
    expect(body.session.instructions).toBe("hi");
    expect(body.session.audio.output.voice).toBe("marin");
    expect(body.session.audio.input.turn_detection.type).toBe("server_vad");
    expect(body.session.audio.input.transcription.model).toBe("gpt-live-transcribe");
  });

  it("maps an OpenAI 401 to BLOCKED_BY_OPENAI_KEY", async () => {
    const app = createApp({ env: { OPENAI_API_KEY: "sk-bad" }, fetch: mockFetch(() => new Response("invalid", { status: 401 })) });
    const res = await post(app, "/api/token/openai", {});
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("BLOCKED_BY_OPENAI_KEY");
  });

  it("mints a Gemini ephemeral token via v1beta/auth_tokens", async () => {
    const calls: Call[] = [];
    const app = createApp({
      env: { GEMINI_API_KEY: "gk-test" },
      fetch: mockFetch(() => new Response(JSON.stringify({ name: "auth_tokens/abc", expireTime: "2026-08-30T10:00:00Z" })), calls),
      now: () => Date.parse("2026-08-30T09:00:00Z"),
    });
    const res = await post(app, "/api/token/gemini", {});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token).toBe("auth_tokens/abc");
    expect(json.model).toBe("gemini-3.1-flash-live-preview");
    expect(json.expiresAt).toBe(Date.parse("2026-08-30T10:00:00Z"));
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    expect((calls[0]!.init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("gk-test");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.uses).toBe(1);
    expect(body.expireTime).toBe("2026-08-30T09:30:00.000Z");
    expect(body.newSessionExpireTime).toBe("2026-08-30T09:02:00.000Z");
    // No setup constraint: Google would use it INSTEAD of the client setup, dropping transcription and voice.
    expect(body.bidiGenerateContentSetup).toBeUndefined();
  });

  it("/api/plan falls back to the heuristic without a key and uses the LLM when available", async () => {
    const noKey = createApp({ env: {} });
    const res = await post(noKey, "/api/plan", { speaker: "assistant", text: "それは、とても良い回答ですね。", mode: "free_talk" });
    expect(res.headers.get("x-plan-source")).toBe("heuristic");
    expect((await res.json()).emotion).toBe("warm_positive");

    const withKey = createApp({
      env: { OPENAI_API_KEY: "sk" },
      fetch: mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ emotion: "laugh", emotionIntensity: 0.9, gesture: "celebrate", gestureIntensity: 5, energy: 0.8, question: false }) } }] }))),
    });
    const res2 = await post(withKey, "/api/plan", { speaker: "assistant", text: "やった！", mode: "free_talk" });
    expect(res2.headers.get("x-plan-source")).toBe("openai");
    const plan = await res2.json();
    expect(plan.emotion).toBe("laugh");
    expect(plan.gestureIntensity).toBe(1);

    const broken = createApp({ env: { OPENAI_API_KEY: "sk" }, fetch: mockFetch(() => new Response("boom", { status: 500 })) });
    const res3 = await post(broken, "/api/plan", { speaker: "assistant", text: "すごい！", mode: "free_talk" });
    expect(res3.headers.get("x-plan-source")).toBe("heuristic");
    expect((await res3.json()).emotion).toBe("surprised");
  });

  it("creates a LiveKit token when configured", async () => {
    const app = createApp({ env: { LIVEKIT_URL: "wss://x.livekit.cloud", LIVEKIT_API_KEY: "APIxxxxxxxx", LIVEKIT_API_SECRET: "secretsecretsecretsecretsecretsecret" } });
    const res = await post(app, "/api/livekit/token", { room: "room1", identity: "user1" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.url).toBe("wss://x.livekit.cloud");
    expect(json.token.split(".").length).toBe(3);
  });

  it("tavus + heygen route through the documented endpoints", async () => {
    const calls: Call[] = [];
    const app = createApp({
      env: { TAVUS_API_KEY: "tv", HEYGEN_API_KEY: "hg", HEYGEN_AVATAR_ID: "av1" },
      fetch: mockFetch((url) => {
        if (url.includes("tavusapi.com")) return new Response(JSON.stringify({ conversation_id: "c1", conversation_url: "https://tavus.daily.co/c1", status: "active" }));
        if (url.endsWith("sessions/token")) return new Response(JSON.stringify({ data: { session_id: "s1", session_token: "st" } }));
        if (url.endsWith("sessions/start")) return new Response(JSON.stringify({ data: { session_id: "s1", livekit_url: "wss://lk", livekit_client_token: "lt", ws_url: "wss://ws" } }));
        return new Response(JSON.stringify({ data: {} }));
      }, calls),
    });
    const t = await (await post(app, "/api/avatar/tavus/conversation", { replicaId: "r1", personaId: "p1" })).json();
    expect(t).toEqual({ conversationId: "c1", conversationUrl: "https://tavus.daily.co/c1", status: "active" });
    expect((calls[0]!.init!.headers as Record<string, string>)["x-api-key"]).toBe("tv");
    const h = await (await post(app, "/api/avatar/heygen/session", {})).json();
    expect(h.sessionId).toBe("s1");
    expect(h.livekitUrl).toBe("wss://lk");
    expect(h.livekitClientToken).toBe("lt");
    expect(h.wsUrl).toBe("wss://ws");
    expect(h.mode).toBe("LITE");
    expect(calls.map((c) => c.url.split("/").slice(-2).join("/"))).toEqual(["v2/conversations", "sessions/token", "sessions/start"]);
    expect((calls[1]!.init!.headers as Record<string, string>)["X-API-KEY"]).toBe("hg");
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ mode: "LITE", avatar_id: "av1" });
    expect((calls[2]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer st");
  });

  it("parseDotenv handles quotes, comments and export", () => {
    expect(parseDotenv('# c\nexport A="x y"\nB=\'z\'\nC=\n\nD=1=2')).toEqual({ A: "x y", B: "z", C: "", D: "1=2" });
  });
});

describe("meeting (Recall) routes", () => {
  it("503 BLOCKED_BY_RECALL_KEY without a key, BLOCKED_BY_RECALL_PUBLIC_URL without a tunnel", async () => {
    const noKey = createApp({ env: {}, fetch: mockFetch(() => new Response("{}"), []) });
    expect((await post(noKey, "/api/meeting/recall/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij" })).status).toBe(503);
    expect(await (await post(noKey, "/api/meeting/recall/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij" })).json()).toEqual({ error: "BLOCKED_BY_RECALL_KEY" });
    const noUrl = createApp({ env: { RECALL_API_KEY: "rk" }, fetch: mockFetch(() => new Response("{}"), []) });
    const r = await post(noUrl, "/api/meeting/recall/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij" });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe("BLOCKED_BY_RECALL_PUBLIC_URL");
  });
  it("creates a bot with realtime relay + output_media webpage and maps status/leave", async () => {
    const calls: Call[] = [];
    const app = createApp({
      env: { RECALL_API_KEY: "rk", RECALL_REGION: "ap-northeast-1", RECALL_PUBLIC_URL: "https://tunnel.example", RECALL_BOT_PAGE_URL: "https://web.example" },
      clientWsBase: "ws://localhost:8787",
      fetch: mockFetch((url) => {
        if (url.endsWith("/api/v1/bot/")) return new Response(JSON.stringify({ id: "bot42", status_changes: [{ code: "joining_call" }] }));
        if (url.endsWith("/api/v1/bot/bot42/")) return new Response(JSON.stringify({ id: "bot42", meeting_url: { platform: "google_meet" }, status_changes: [{ code: "joining_call" }, { code: "in_call_recording", sub_code: null, created_at: "t" }] }));
        if (url.endsWith("/leave_call/")) return new Response("", { status: 200 });
        return new Response("{}");
      }, calls),
    });
    const created = await (await post(app, "/api/meeting/recall/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Yui", mode: "output_media", language: "ja-JP", botPageQuery: { character: "yui" } })).json();
    expect(created).toMatchObject({ botId: "bot42", status: "joining_call", mode: "output_media", region: "ap-northeast-1" });
    expect(created.clientWsUrl).toMatch(/^ws:\/\/localhost:8787\/api\/meeting\/recall\/client\/bot42\?token=[A-Za-z0-9_%.-]+$/);
    expect(typeof created.sessionId).toBe("string");
    expect(typeof created.clientToken).toBe("string");
    expect(calls[0]!.url).toBe("https://ap-northeast-1.recall.ai/api/v1/bot/");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("rk");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.meeting_url).toBe("https://meet.google.com/abc-defg-hij");
    expect(body.bot_name).toBe("Yui");
    expect(body.recording_config.audio_mixed_raw).toEqual({});
    expect(body.recording_config.transcript.provider.recallai_streaming).toEqual({ mode: "prioritize_accuracy", language_code: "ja" });
    const ep = body.recording_config.realtime_endpoints[0];
    expect(ep.type).toBe("websocket");
    expect(ep.url).toMatch(/^wss:\/\/tunnel\.example\/api\/meeting\/recall\/relay\/[A-Za-z0-9_%.-]+\/$/);
    expect(ep.events).toContain("audio_mixed_raw.data");
    expect(ep.events).toContain("transcript.data");
    expect(body.output_media.camera.kind).toBe("webpage");
    // Gate 5: the bot page URL carries only a signed single-use token — never botId/character in the clear.
    expect(body.output_media.camera.config.url).toMatch(/^https:\/\/web\.example\/\?rcai_bot=1&token=[A-Za-z0-9_.-]+$/);
    expect(body.output_media.camera.config.url).not.toContain("character");
    const status = await (await app.request("/api/meeting/recall/bots/bot42")).json();
    expect(status).toMatchObject({ botId: "bot42", code: "in_call_recording" });
    const left = await post(app, "/api/meeting/recall/bots/bot42/leave", {});
    expect(left.status).toBe(200);
    expect(calls.at(-1)!.url).toBe("https://ap-northeast-1.recall.ai/api/v1/bot/bot42/leave_call/");
    // Conversational audio goes through Output Media; Output Audio is off unless a deployment opts in.
    const off = await post(app, "/api/meeting/recall/bots/bot42/output_audio", { kind: "mp3", b64_data: "AA==" });
    expect(off.status).toBe(409);
    expect((await off.json()).error).toBe("OUTPUT_AUDIO_DISABLED");
    const allowed = createApp({
      env: { RECALL_API_KEY: "rk", RECALL_REGION: "ap-northeast-1", RECALL_ALLOW_OUTPUT_AUDIO: "1" },
      fetch: mockFetch(() => new Response("{}")),
    });
    const bad = await post(allowed, "/api/meeting/recall/bots/bot42/output_audio", { kind: "wav" });
    expect(bad.status).toBe(400);
  });
});

describe("meeting session security (Round 3 Gate 5)", () => {
  const env = { RECALL_API_KEY: "rk", RECALL_REGION: "us-west-2", RECALL_PUBLIC_URL: "https://tunnel.example", RECALL_BOT_PAGE_URL: "https://web.example", MEETING_TOKEN_SECRET: "a-test-secret-of-sufficient-length" };
  function mk(now: { t: number }) {
    const calls: Call[] = [];
    const sessions = new MeetingSessionRegistry(env.MEETING_TOKEN_SECRET, () => now.t);
    const relay = new RelayHubCls("ws://localhost:8787", () => now.t);
    const app = createApp({
      env,
      sessions,
      relay,
      now: () => now.t,
      fetch: mockFetch((url, init) => {
        if (url.endsWith("/api/v1/bot/") && init?.method === "POST") return new Response(JSON.stringify({ id: "bot7", status_changes: [{ code: "joining_call" }] }));
        if (url.endsWith("/api/v1/bot/bot7/")) return new Response(JSON.stringify({ id: "bot7", status_changes: [{ code: "in_call_recording" }] }));
        if (url.endsWith("/output_media/")) return new Response("{}", { status: 200 });
        return new Response("", { status: 200 });
      }, calls),
    });
    return { app, sessions, relay, calls };
  }
  const create = (app: ReturnType<typeof createApp>, extra: Record<string, unknown> = {}) => post(app, "/api/meeting/recall/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Yui", mode: "output_media", botPageQuery: { character: "yui", persona: "friend_ja" }, ...extra });

  it("bot page activation: valid token once, replay → 401, config comes from the server", async () => {
    const now = { t: 1_000_000 };
    const { app, sessions } = mk(now);
    const created = await (await create(app)).json();
    const pageToken = new URL(created.botPageUrl).searchParams.get("token")!;
    const first = await post(app, "/api/meeting/session/activate", { token: pageToken });
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ botId: "bot7", sessionId: created.sessionId, botPageQuery: { character: "yui", persona: "friend_ja" } });
    expect(body.clientWsUrl).toMatch(/client\/bot7\?token=/);
    const replay = await post(app, "/api/meeting/session/activate", { token: pageToken });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "invalid_bot_page_token", detail: "replayed" });
    expect((await post(app, "/api/meeting/session/activate", { token: "junk" })).status).toBe(401);
    expect((await post(app, "/api/meeting/session/activate", {})).status).toBe(401);
    // expiry: 15 minutes
    const fresh = sessions.issue(created.sessionId, "bot_page");
    now.t += 15 * 60_000;
    expect(await (await post(app, "/api/meeting/session/activate", { token: fresh })).json()).toEqual({ error: "invalid_bot_page_token", detail: "expired" });
  });
  it("bot page reports: the page's own account of a run is readable from outside the vendor", async () => {
    const now = { t: 1_000_000 };
    const { app } = mk(now);
    const created = await (await create(app)).json();
    const pageToken = new URL(created.botPageUrl).searchParams.get("token")!;
    const act = await (await post(app, "/api/meeting/session/activate", { token: pageToken })).json();
    const sid = act.sessionId as string;
    const auth = { Authorization: `Bearer ${act.clientToken}` };
    const report = (body: Record<string, unknown>, headers: Record<string, string> = auth) => app.request(`/api/meeting/session/${sid}/report`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await report({ type: "turn", data: { reason: "addressed" } }, {})).status).toBe(401);
    expect((await report({ data: {} })).status).toBe(400);
    expect((await report({ type: "turn", data: { text: "x".repeat(5000) } })).status).toBe(413);
    expect((await report({ type: "greeting", data: { now: true } })).status).toBe(200);
    now.t += 5000;
    expect((await report({ type: "heartbeat", data: { fps: 12 } })).status).toBe(200);
    now.t += 5000;
    expect((await report({ type: "heartbeat", data: { fps: 30 } })).status).toBe(200);
    expect((await report({ type: "turn", data: { reason: "addressed", text: "ゆい" } })).status).toBe(200);
    const st = await (await app.request(`/api/meeting/session/${sid}`, { headers: auth })).json();
    // Events keep their order and the broker's clock; only the latest heartbeat is kept.
    expect(st.pageEvents.map((e: { type: string }) => e.type)).toEqual(["greeting", "turn"]);
    expect(st.pageEvents[0].at).toBe(1_000_000);
    expect(st.pageHeartbeat).toMatchObject({ type: "heartbeat", at: 1_010_000, data: { fps: 30 } });
  });
  it("operator routes need the client token of the same session; refresh issues a new bot-page URL; revoke kills tokens", async () => {
    const now = { t: 1_000_000 };
    const { app, sessions } = mk(now);
    const created = await (await create(app)).json();
    const sid = created.sessionId as string;
    const auth = { Authorization: `Bearer ${created.clientToken}` };
    expect((await app.request(`/api/meeting/session/${sid}`)).status).toBe(401);
    const st = await app.request(`/api/meeting/session/${sid}`, { headers: auth });
    expect(st.status).toBe(200);
    expect(await st.json()).toMatchObject({ sessionId: sid, botId: "bot7", revoked: false, ended: false, activations: 0 });
    // other session's token → 403
    const other = await (await create(app, { meetingUrl: "https://meet.google.com/zzz-zzzz-zzz" })).json();
    expect((await app.request(`/api/meeting/session/${sid}`, { headers: { Authorization: `Bearer ${other.clientToken}` } })).status).toBe(403);
    const refreshed = await app.request(`/api/meeting/session/${sid}/refresh`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ role: "bot_page" }) });
    expect(refreshed.status).toBe(200);
    const rb = await refreshed.json();
    expect(rb.botPageUrl).toMatch(/^https:\/\/web\.example\/\?rcai_bot=1&token=/);
    expect((await post(app, "/api/meeting/session/activate", { token: rb.token })).status).toBe(200);
    expect((await app.request(`/api/meeting/session/${sid}/refresh`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ role: "relay" }) })).status).toBe(400);
    const revoked = await app.request(`/api/meeting/session/${sid}/revoke`, { method: "POST", headers: auth });
    expect(revoked.status).toBe(200);
    expect(sessions.verify(created.clientToken as string)).toMatchObject({ ok: false, reason: "revoked" });
    expect((await app.request(`/api/meeting/session/${sid}`, { headers: auth })).status).toBe(401);
  });
  it("duplicate join → 409 unless force; leave ends the session and cleans the relay", async () => {
    const now = { t: 1_000_000 };
    const { app, sessions, relay } = mk(now);
    const a = await (await create(app)).json();
    const dup = await create(app);
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "DUPLICATE_JOIN", sessionId: a.sessionId, botId: "bot7" });
    expect((await create(app, { force: true })).status).toBe(200);
    relay.addClient("bot7", { send: () => {}, close: () => {} });
    expect(relay.clientCount("bot7")).toBe(1);
    expect((await post(app, "/api/meeting/recall/bots/bot7/leave", {})).status).toBe(200);
    expect(sessions.get(a.sessionId as string)?.ended).toBe(true);
    expect(relay.clientCount("bot7")).toBe(0);
    expect(sessions.verify(a.clientToken as string)).toMatchObject({ ok: false, reason: "ended" });
    // a new join after leaving is allowed again
    expect((await create(app)).status).toBe(200);
  });
  it("status poll with done/fatal ends the session; output media restart issues a fresh single-use token", async () => {
    const now = { t: 1_000_000 };
    const { app, sessions, calls } = mk(now);
    const created = await (await create(app)).json();
    const restart = await post(app, "/api/meeting/recall/bots/bot7/output_media/restart", {});
    expect(restart.status).toBe(200);
    expect(await restart.json()).toEqual({ ok: true, restarts: 1 });
    const om = calls.filter((c) => c.url.endsWith("/bot/bot7/output_media/"));
    expect(om.map((c) => c.init?.method)).toEqual(["DELETE", "POST"]);
    const newUrl = JSON.parse(om[1]!.init!.body as string).camera.config.url as string;
    expect(newUrl).not.toBe(created.botPageUrl);
    expect((await post(app, "/api/meeting/session/activate", { token: new URL(newUrl).searchParams.get("token")! })).status).toBe(200);
    // fatal on poll → session ended
    const { app: app2, sessions: sessions2 } = (() => {
      const calls2: Call[] = [];
      const s2 = new MeetingSessionRegistry(env.MEETING_TOKEN_SECRET, () => now.t);
      const a2 = createApp({ env, sessions: s2, now: () => now.t, fetch: mockFetch((url, init) => {
        if (url.endsWith("/api/v1/bot/") && init?.method === "POST") return new Response(JSON.stringify({ id: "bot9", status_changes: [{ code: "joining_call" }] }));
        if (url.endsWith("/api/v1/bot/bot9/")) return new Response(JSON.stringify({ id: "bot9", status_changes: [{ code: "fatal", sub_code: "meeting_not_found" }] }));
        return new Response("{}");
      }, calls2) });
      return { app: a2, sessions: s2 };
    })();
    const c2 = await (await create(app2)).json();
    const st = await (await app2.request("/api/meeting/recall/bots/bot9")).json();
    expect(st).toMatchObject({ code: "fatal", subCode: "meeting_not_found" });
    expect(sessions2.get(c2.sessionId as string)).toMatchObject({ ended: true, endReason: "fatal/meeting_not_found" });
    void sessions;
  });
  it("websocket upgrade auth: relay/client tokens, bot binding, expiry, revoke", async () => {
    const now = { t: 1_000_000 };
    const { app, sessions, relay } = mk(now);
    const { authorizeWebSocketUpgrade } = await import("./meeting-ws-auth.js");
    const created = await (await create(app)).json();
    const relayToken = decodeURIComponent((await (async () => {
      // relay token is only in the Recall create-bot body; recover it from the registry-issued URL by re-issuing? No — parse from the session: issue a relay token equivalent.
      return sessions.issue(created.sessionId as string, "relay");
    })()));
    relay.register(relayToken);
    relay.bind(relayToken, "bot7");
    expect(authorizeWebSocketUpgrade(`/api/meeting/recall/relay/${encodeURIComponent(relayToken)}/`, sessions, relay, now.t)).toMatchObject({ ok: true, kind: "relay", botId: "bot7" });
    expect(authorizeWebSocketUpgrade("/api/meeting/recall/relay/bogus/", sessions, relay, now.t)).toMatchObject({ ok: false, status: 401, reason: "malformed" });
    expect(authorizeWebSocketUpgrade("/api/meeting/recall/client/bot7", sessions, relay, now.t)).toMatchObject({ ok: false, status: 401, reason: "token_required" });
    expect(authorizeWebSocketUpgrade(`/api/meeting/recall/client/bot7?token=${encodeURIComponent(created.clientToken)}`, sessions, relay, now.t)).toMatchObject({ ok: true, kind: "client", botId: "bot7" });
    expect(authorizeWebSocketUpgrade(`/api/meeting/recall/client/OTHER?token=${encodeURIComponent(created.clientToken)}`, sessions, relay, now.t)).toMatchObject({ ok: false, reason: "bot_mismatch" });
    expect(authorizeWebSocketUpgrade(`/api/meeting/recall/client/bot7?token=${encodeURIComponent(relayToken)}`, sessions, relay, now.t)).toMatchObject({ ok: false, reason: "wrong_role" });
    expect(authorizeWebSocketUpgrade(`/api/meeting/recall/client/bot7?token=${encodeURIComponent(created.clientToken)}`, sessions, relay, now.t + 61 * 60_000)).toMatchObject({ ok: false, reason: "expired" });
    sessions.revoke(created.sessionId as string);
    expect(authorizeWebSocketUpgrade(`/api/meeting/recall/relay/${encodeURIComponent(relayToken)}/`, sessions, relay, now.t)).toMatchObject({ ok: false, reason: "revoked" });
    expect(authorizeWebSocketUpgrade("/somewhere/else", sessions, relay, now.t)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("RelayHub", () => {
  it("fans Recall messages out to bot clients, validates tokens, buffers non-audio events", async () => {
    const { RelayHub } = await import("./meeting-relay.js");
    const hub = new RelayHub("ws://localhost:8787", () => 5);
    hub.register("tok");
    expect(hub.isValidToken("tok")).toBe(true);
    expect(hub.isValidToken("nope")).toBe(false);
    hub.bind("tok", "botA");
    expect(hub.clientUrl("botA")).toBe("ws://localhost:8787/api/meeting/recall/client/botA");
    expect(hub.onRecallMessage("tok", JSON.stringify({ event: "audio_mixed_raw.data", data: {} }))).toBe(0);
    expect(hub.onRecallMessage("tok", JSON.stringify({ event: "participant_events.join", data: {} }))).toBe(0);
    const got: string[] = [];
    const remove = hub.addClient("botA", { send: (d) => got.push(d), close() {} });
    expect(got.length).toBe(1); // buffered join replayed, audio dropped
    expect(JSON.parse(got[0]!)).toEqual({ relay: { botId: "botA", receivedAt: 5 }, message: { event: "participant_events.join", data: {} } });
    expect(hub.onRecallMessage("tok", JSON.stringify({ event: "transcript.data", data: {} }))).toBe(1);
    remove();
    expect(hub.clientCount("botA")).toBe(0);
  });

  it("keeps when the mixed audio had holes and how many chunks were exact zeros (run 77: ears dead with memory fine)", async () => {
    const { RelayHub } = await import("./meeting-relay.js");
    let wall = 1000;
    const hub = new RelayHub("ws://localhost:8787", () => wall);
    hub.register("tok");
    hub.bind("tok", "botA");
    const zeros = Buffer.alloc(960).toString("base64"); // 20 ms of 24 kHz int16 silence
    const sound = Buffer.from([0, 0, 1, 0, 0, 0]).toString("base64");
    const send = (t: number, chunk: string) => hub.onRecallMessage("tok", JSON.stringify({ trigger: "realtime_audio.mixed", data: { chunk, sample_rate: 24000, timestamp_ms: t } }));
    send(0, sound); send(20, sound); send(40, zeros);
    wall = 2000; send(900, zeros); // 860 ms missing before this chunk
    send(920, sound); send(1500, sound); // another 580 ms
    const a = hub.stats("botA").audio;
    expect(a.chunks).toBe(6);
    expect(a.zeroChunks).toBe(2);
    expect(a.gaps).toBe(2);
    expect(a.gapMs).toBe(860 + 580);
    expect(a.holes).toEqual([{ t: 900, ms: 860, at: 2000 }, { t: 1500, ms: 580, at: 2000 }]);
    // an all-zero chunk is base64 "A…" with padding; a chunk with any sample set is not
    expect(hub.stats("nobody").audio).toEqual({ chunks: 0, gaps: 0, gapMs: 0, zeroChunks: 0, holes: [] });
  });
});

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

describe("human gate feedback", () => {
  it("appends observations as JSON lines to docs/reports/human/<date>.jsonl", async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), "rcai-feedback-"));
    const app = createApp({ env: {}, feedbackDir: dir });
    const res = await post(app, "/api/feedback", { entries: [{ at: 1, kind: "observation", tag: "頷きすぎ", avatarState: "LISTENING", captions: ["You: こんにちは"] }, { at: 2, kind: "rating", rating: { listening: 4 } }, { at: "x", kind: "bogus" }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.written).toBe(2);
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
    const lines = readFileSync(joinPath(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual(["observation", "rating"]);
    expect(lines[0].tag).toBe("頷きすぎ");
    expect((await post(app, "/api/feedback", { entries: [] })).status).toBe(400);
  });
});

describe("incidents + telemetry (Round 3 Gate 6/7)", () => {
  it("stores an incident JSON and writes media only when opted in", async () => {
    const files = new Map<string, string | Uint8Array>();
    const { recordIncident } = await import("./routes/incidents.js");
    const base = { id: "inc_1", sessionId: "s_abc", at: 1, windowMs: 10000, reason: "不自然だった瞬間", entries: [{ kind: "state", rel: -100 }], micWavBase64: "AAAA", assistantWavBase64: "BBBB", videoFrameJpegBase64: "CCCC" };
    const r1 = await recordIncident({ ...base, userOptIn: { audio: false, video: false } }, { dir: "/tmp/x", write: async (f, d) => { files.set(f, d); }, now: () => 5 });
    expect(r1.status).toBe(200);
    expect([...files.keys()].some((f) => f.endsWith("inc_1.json"))).toBe(true);
    expect([...files.keys()].some((f) => f.endsWith(".wav") || f.endsWith(".jpg"))).toBe(false);
    const json = JSON.parse(String([...files.values()][0]));
    expect(json.micWavBase64).toBeUndefined();
    expect(json.media).toEqual([]);
    files.clear();
    const r2 = await recordIncident({ ...base, id: "inc_2", userOptIn: { audio: true, video: true } }, { dir: "/tmp/x", write: async (f, d) => { files.set(f, d); } });
    expect(r2.status).toBe(200);
    expect([...files.keys()].filter((f) => /\.(wav|jpg)$/.test(f)).length).toBe(3);
    const bad = await recordIncident({ ...base, id: "../evil" } as never, { write: async () => {} });
    expect(bad.status).toBe(400);
  });
  it("telemetry accepts numbers-only envelopes and rejects user content", async () => {
    const { recordTelemetry, findContentKey } = await import("./routes/telemetry.js");
    const lines: string[] = [];
    const ok = await recordTelemetry({ schema: "rcai.telemetry.v1", sentAt: 1, privacyMode: "default", report: { sessionId: "s1", turns: { user: 2 } } }, { append: async (_f, l) => { lines.push(l); }, now: () => 1 });
    expect(ok.status).toBe(200);
    expect(lines.length).toBe(1);
    const bad = await recordTelemetry({ schema: "rcai.telemetry.v1", sentAt: 1, privacyMode: "default", report: { sessionId: "s1", nested: { transcript: "hello" } } }, { append: async () => {} });
    expect(bad.status).toBe(400);
    expect((bad.body as { key?: string }).key).toBe("report.nested.transcript");
    expect(findContentKey({ a: [{ b: { text: "x" } }] })).toBe("a[0].b.text");
    const wrong = await recordTelemetry({ hello: 1 }, { append: async () => {} });
    expect(wrong.status).toBe(400);
    const app = createApp({ env: {}, telemetryDir: "/tmp/rcai-telemetry-test" });
    const res = await post(app, "/api/telemetry", { schema: "rcai.telemetry.v1", sentAt: 1, privacyMode: "default", report: { sessionId: "s1", text: "no" } });
    expect(res.status).toBe(400);
  });
});

describe("COMMERCIAL-GATE-04: webhook is the only product state source", () => {
  const envFor = () => ({ RECALL_API_KEY: "rk", RECALL_REGION: "ap-northeast-1", RECALL_WEBHOOK_VERIFICATION_SECRET: "" });

  it("a repeated delivery and a late earlier one leave the state alone", async () => {
    const { shouldApplyStatus } = await import("./recall/botState.js");
    expect(shouldApplyStatus("in_call_recording", "in_call_recording")).toBe(false);
    expect(shouldApplyStatus("in_call_recording", "in_waiting_room")).toBe(false);
    expect(shouldApplyStatus("in_waiting_room", "in_call_recording")).toBe(true);
  });

  it("an unsigned webhook is refused before the body is read", async () => {
    const app = createApp({ env: { ...envFor(), RECALL_WEBHOOK_VERIFICATION_SECRET: "whsec_" + Buffer.from("k").toString("base64") } });
    const res = await app.request("/api/recall/webhooks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "bot.done" }) });
    expect([401, 403]).toContain(res.status);
  });

  it("the diagnostic bot GET and reconcile need the admin token", async () => {
    const app = createApp({ env: { ...envFor(), RECALL_ADMIN_TOKEN: "secret" } });
    expect((await app.request("/api/meeting/recall/bots/bot1")).status).toBe(403);
    expect((await app.request("/api/meeting/recall/bots/bot1/reconcile", { method: "POST" })).status).toBe(403);
  });
});

describe("operations: a missed webhook is recoverable", () => {
  it("a dropped delivery leaves the meeting stale, and reconcile puts it right", async () => {
    const calls: { url: string }[] = [];
    const app = createApp({
      env: { RECALL_API_KEY: "rk", RECALL_REGION: "ap-northeast-1", RECALL_PUBLIC_URL: "https://tunnel.example", RECALL_BOT_PAGE_URL: "https://web.example" },
      fetch: mockFetch((url: string) => {
        if (url.endsWith("/api/v1/bot/")) return new Response(JSON.stringify({ id: "botR", status_changes: [{ code: "joining_call" }] }));
        // Recall's truth: the bot is recording. The webhook that said so never arrived.
        if (url.endsWith("/api/v1/bot/botR/")) return new Response(JSON.stringify({ id: "botR", status_changes: [{ code: "joining_call" }, { code: "in_call_recording", sub_code: null, created_at: "t" }] }));
        return new Response("{}");
      }, calls),
    });
    const created = await (await post(app, "/api/meeting/recall/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Yui", mode: "relay" })).json();
    const before = await (await app.request(`/api/meetings/${created.meetingRecordId}`)).json();
    expect(before.meeting.status).not.toBe("in_call_recording");

    const rec = await (await app.request("/api/meeting/recall/bots/botR/reconcile", { method: "POST" })).json();
    expect(rec.reconciled).toBe(true);
    const after = await (await app.request(`/api/meetings/${created.meetingRecordId}`)).json();
    expect(after.meeting.status).toBe("in_call_recording");
    expect(after.meeting.lifecycle.at(-1).event).toBe("reconcile:in_call_recording");
  });

  it("reconcile never drags a meeting backwards", async () => {
    const app = createApp({
      env: { RECALL_API_KEY: "rk", RECALL_REGION: "ap-northeast-1", RECALL_PUBLIC_URL: "https://tunnel.example", RECALL_BOT_PAGE_URL: "https://web.example" },
      fetch: mockFetch((url: string) => {
        if (url.endsWith("/api/v1/bot/")) return new Response(JSON.stringify({ id: "botS", status_changes: [{ code: "joining_call" }] }));
        // Recall answers with a state older than the one we already reached.
        if (url.endsWith("/api/v1/bot/botS/")) return new Response(JSON.stringify({ id: "botS", status_changes: [{ code: "in_waiting_room", sub_code: null, created_at: "t" }] }));
        return new Response("{}");
      }),
    });
    const created = await (await post(app, "/api/meeting/recall/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Yui", mode: "relay" })).json();
    await app.request("/api/meeting/recall/bots/botS/reconcile", { method: "POST" }); // to in_waiting_room
    const first = await (await app.request(`/api/meetings/${created.meetingRecordId}`)).json();
    expect(first.meeting.status).toBe("in_waiting_room");
    const again = await (await app.request("/api/meeting/recall/bots/botS/reconcile", { method: "POST" })).json();
    expect(again.reconciled).toBe(false); // already there; nothing to apply
  });
});

describe("operations: an empty Recall account is visible before a user finds it", () => {
  it("health reports when a bot was last refused for credit", async () => {
    const app = createApp({
      env: { RECALL_API_KEY: "rk", RECALL_REGION: "ap-northeast-1", RECALL_PUBLIC_URL: "https://t.example", RECALL_BOT_PAGE_URL: "https://w.example" },
      fetch: mockFetch((url: string) =>
        url.endsWith("/api/v1/bot/")
          ? new Response(JSON.stringify({ code: "insufficient_credit_balance", detail: "Insufficient credit balance to add a bot." }), { status: 402 })
          : new Response("{}"),
      ),
    });
    expect((await (await app.request("/health")).json()).meeting.creditRefusedAt).toBeNull();
    const created = await post(app, "/api/meeting/recall/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Yui", mode: "relay" });
    expect(created.status).toBe(402);
    expect((await created.json()).error).toBe("BLOCKED_BY_RECALL_CREDIT");
    expect((await (await app.request("/health")).json()).meeting.creditRefusedAt).toBeTypeOf("number");
  });
});

describe("Attendee provider", () => {
  it("creates a bot with a bidirectional audio socket at the rate our TTS already produces", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const app = createApp({
      env: { ATTENDEE_API_KEY: "ak", RECALL_PUBLIC_URL: "https://tunnel.example", MEETING_TOKEN_SECRET: "s".repeat(64) },
      fetch: mockFetch(() => new Response(JSON.stringify({ id: "att_1", state: "joining" })), calls),
    });
    const res = await post(app, "/api/meeting/attendee/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Yui" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ provider: "attendee", botId: "att_1", sampleRate: 16000 });
    const req = calls.find((c) => c.url.endsWith("/api/v1/bots"))!;
    expect((req.init!.headers as Record<string, string>).Authorization).toBe("Token ak");
    const sent = JSON.parse(req.init!.body as string);
    expect(sent.meeting_url).toBe("https://meet.google.com/abc-defg-hij");
    // 16 kHz is what the agent's binary input is defined at; 24 kHz stretched every utterance.
    expect(sent.websocket_settings.audio.sample_rate).toBe(16000);
    expect(sent.websocket_settings.audio.url).toMatch(/^wss:\/\/tunnel\.example\/api\/meeting\/attendee\/audio\//);
    // Attendee launches the page only when reserve_resources is true; the url alone is stored and ignored.
    expect(sent.voice_agent_settings).toBeUndefined(); // no bot page URL configured in this test
    // A participant sits through a quiet stretch; the vendor's 600 s recorder default walked out on run 83.
    expect(sent.automatic_leave_settings).toEqual({ silence_timeout_seconds: 3600 });
  });

  it("a deployment can set its own leave timers, and only the ones it names are sent", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const app = createApp({
      env: { ATTENDEE_API_KEY: "ak", RECALL_PUBLIC_URL: "https://tunnel.example", MEETING_TOKEN_SECRET: "s".repeat(64) },
      fetch: mockFetch(() => new Response(JSON.stringify({ id: "att_1", state: "joining" })), calls),
    });
    await post(app, "/api/meeting/attendee/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Yui", automaticLeave: { silenceTimeoutSeconds: 900, maxUptimeSeconds: 7200 } });
    const sent = JSON.parse(calls.find((c) => c.url.endsWith("/api/v1/bots"))!.init!.body as string);
    expect(sent.automatic_leave_settings).toEqual({ silence_timeout_seconds: 900, max_uptime_seconds: 7200 });
  });

  it("reports a missing key rather than pretending", async () => {
    const app = createApp({ env: { RECALL_PUBLIC_URL: "https://t.example" } });
    const res = await post(app, "/api/meeting/attendee/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("BLOCKED_BY_ATTENDEE_KEY");
  });
});

describe("Attendee voice agent page", () => {
  it("asks Attendee to actually launch the page, not just store its URL", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const app = createApp({
      env: { ATTENDEE_API_KEY: "ak", RECALL_PUBLIC_URL: "https://tunnel.example", RECALL_BOT_PAGE_URL: "https://web.example", MEETING_TOKEN_SECRET: "s".repeat(64) },
      fetch: mockFetch(() => new Response(JSON.stringify({ id: "att_2", state: "joining" })), calls),
    });
    await post(app, "/api/meeting/attendee/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Yui" });
    const sent = JSON.parse(calls.find((c) => c.url.endsWith("/api/v1/bots"))!.init!.body as string);
    expect(sent.voice_agent_settings.url).toMatch(/^https:\/\/web\.example\/\?rcai_bot=1&token=/);
    // Without this the bot joins, records, and silently never renders or speaks.
    expect(sent.voice_agent_settings.reserve_resources).toBe(true);
  });
});

describe("Attendee listener bot", () => {
  it("a listener joins with no page, records the room in Japanese, and can be told how to record", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const app = createApp({
      env: { ATTENDEE_API_KEY: "ak", RECALL_PUBLIC_URL: "https://tunnel.example", RECALL_BOT_PAGE_URL: "https://web.example", MEETING_TOKEN_SECRET: "s".repeat(64) },
      fetch: mockFetch(() => new Response(JSON.stringify({ id: "att_3", state: "joining" })), calls),
    });
    const res = await post(app, "/api/meeting/attendee/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Tester", role: "listener", botPageQuery: { language: "ja-JP" }, recording: { view: "gallery_view", resolution: "1080p" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.botPageUrl).toBeUndefined();
    const sent = JSON.parse(calls.find((c) => c.url.endsWith("/api/v1/bots"))!.init!.body as string);
    expect(sent.bot_name).toBe("Tester");
    expect(sent.voice_agent_settings).toBeUndefined();
    expect(sent.transcription_settings).toEqual({ deepgram: { language: "ja" } });
    expect(sent.recording_settings).toEqual({ view: "gallery_view", resolution: "1080p" });
    // Still on the relay: the harness hears the room (and the character in it) on the same socket.
    expect(sent.websocket_settings.audio.url).toMatch(/^wss:\/\/tunnel\.example\/api\/meeting\/attendee\/audio\//);
    expect(body.clientWsUrl).toContain("att_3");
  });

  it("can read the platform's own captions instead of asking Deepgram (no credential on a self-hosted stack)", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const app = createApp({
      env: { ATTENDEE_API_KEY: "ak", RECALL_PUBLIC_URL: "https://tunnel.example", RECALL_BOT_PAGE_URL: "https://web.example", MEETING_TOKEN_SECRET: "s".repeat(64) },
      fetch: mockFetch(() => new Response(JSON.stringify({ id: "att_4", state: "joining" })), calls),
    });
    const res = await post(app, "/api/meeting/attendee/bots", { meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Tester", role: "listener", botPageQuery: { language: "ja-JP" }, transcription: "closed_captions" });
    expect(res.status).toBe(200);
    const sent = JSON.parse(calls.find((c) => c.url.endsWith("/api/v1/bots"))!.init!.body as string);
    expect(sent.transcription_settings).toEqual({ meeting_closed_captions: { google_meet_language: "ja-JP", merge_consecutive_captions: true } });
  });
});

describe("Attendee cleanup", () => {
  it("can stop a bot it started — waiting-room and in-call time are both billed", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const app = createApp({
      env: { ATTENDEE_API_KEY: "ak", RECALL_PUBLIC_URL: "https://tunnel.example", MEETING_TOKEN_SECRET: "s".repeat(64) },
      fetch: mockFetch(() => new Response("{}"), calls),
    });
    const res = await post(app, "/api/meeting/attendee/bots/att_9/leave", {});
    expect(res.status).toBe(200);
    const req = calls.at(-1)!;
    expect(req.url).toBe("https://app.attendee.dev/api/v1/bots/att_9/leave");
    expect(req.init!.method).toBe("POST");
  });
});
