import { createOpenAILiveSession } from "./routes/openaiLive.js";
import { ZoomConnections, ZoomAuthError } from "./zoom/connection.js";
import { FirestoreZoomStore } from "./zoom/store.js";
import { registerZoomRoutes, bearer } from "./zoom/routes.js";
import { VertexLiveRelay } from "./vertex-live.js";
import { lookupLiveInfo } from "./routes/lookup.js";
import { parseLookupArguments } from "@rcai/meeting-core";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { EvaluationInput } from "@rcai/provider-core";
import type { MotionPlanInput } from "@rcai/behavior-engine";
import type { BrokerEnv } from "./env.js";
import { createOpenAIClientSecret, type OpenAITokenRequest } from "./routes/openai.js";
import { createGeminiEphemeralToken } from "./routes/gemini.js";
import { createLiveKitToken } from "./routes/livekit.js";
import { createHeyGenSession, stopHeyGenSession } from "./routes/heygen.js";
import { createTavusConversation } from "./routes/tavus.js";
import { planWithOpenAI } from "./routes/plan.js";
import { recordFeedback, type FeedbackEntry } from "./routes/feedback.js";
import { recordIncident, type IncidentBody } from "./routes/incidents.js";
import { recordTelemetry } from "./routes/telemetry.js";
import { publicWsBase, activateBotPage, authorizeOperator, createRecallBot, getMeetingSession, reportFromBotPage, getRecallBot, leaveRecallBot, outputRecallAudio, refreshMeetingToken, restartOutputMedia, revokeMeetingSession, type CreateBotBody } from "./routes/meeting.js";
import { RelayHub } from "./meeting-relay.js";
import { MeetingSessionRegistry } from "./meeting-session.js";
import { fallbackHeuristic, loadEvaluationModule } from "./evaluation-bridge.js";
import { RecallClient } from "./recall/client.js";
import { MeetingStore } from "./recall/store.js";
import { WebhookQueue } from "./recall/queue.js";
import { headerMap, RecallVerificationError, verifyRequestFromRecall } from "./recall/verify.js";
import { handleWebhookJob } from "./routes/webhooks.js";
import { CalendarStore } from "./recall/calendarStore.js";
import { RecallCalendarClient } from "./recall/calendarClient.js";
import { CalendarSync, handleCalendarWebhook, isCalendarEvent } from "./recall/calendarSync.js";
import { calendarBotConfig } from "./recall/calendarBotConfig.js";
import { calendarEvents, calendarStatus, forwardCalendarCallback, getRule, putRule, setEventOverride } from "./routes/calendar.js";

export interface AppDeps {
  env: BrokerEnv;
  zoom?: ZoomConnections;
  vertex?: VertexLiveRelay;
  fetch?: typeof fetch;
  now?: () => number;
  /** Meeting relay hub (shared with the websocket server); created if omitted. */
  relay?: RelayHub;
  /** Base URL browsers use to open the client relay websocket (default ws://localhost:PORT). */
  clientWsBase?: string;
  /** Override for the human-gate feedback directory (tests). */
  feedbackDir?: string;
  /** Override for presence-incident storage (tests). */
  incidentsDir?: string;
  /** Override for telemetry JSONL storage (tests). */
  telemetryDir?: string;
  /** Meeting session registry (shared with the websocket server); created if omitted. */
  sessions?: MeetingSessionRegistry;
  /** Durable meeting/transcript store (Recall lifecycle); created from RECALL_DATA_DIR if omitted. */
  store?: MeetingStore;
  /** Calendar V2 rule/override/ledger store; created from RECALL_DATA_DIR if omitted. */
  calendarStore?: CalendarStore;
  /** Durable webhook queue; created if omitted. Tests pass one and drain it manually. */
  queue?: WebhookQueue;
  /** Start the queue worker (default true outside tests). */
  startWorker?: boolean;
}

export function createApp(deps: AppDeps): Hono {
  const env = deps.env;
  const vertex = deps.vertex ?? new VertexLiveRelay(env);
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  /**
   * The relay's client URL is handed to the bot page, which runs inside Recall's browser where loopback
   * is blocked — a localhost base there is unreachable by construction. Prefer the public origin whenever
   * the meeting connector is configured.
   */
  const clientWsBase = deps.clientWsBase ?? (env.RECALL_PUBLIC_URL ? publicWsBase(env.RECALL_PUBLIC_URL) : `ws://localhost:${env.PORT ?? 8787}`);
  const relay = deps.relay ?? new RelayHub(clientWsBase, now);
  const sessions = deps.sessions ?? new MeetingSessionRegistry(env.MEETING_TOKEN_SECRET, now);
  const app = new Hono();

  // ---- Recall durable lifecycle (store + webhook queue) ----------------------------------------
  const store = deps.store ?? new MeetingStore(env.RECALL_DATA_DIR, now);
  const meetingDeps = { relay, sessions, store };
  const queue = deps.queue ?? new WebhookQueue({ dir: env.RECALL_DATA_DIR ? `${env.RECALL_DATA_DIR}/queue` : undefined, now });
  const recallClient = () => new RecallClient({ apiKey: env.RECALL_API_KEY!, region: env.RECALL_REGION ?? "us-west-2", fetchImpl });
  /**
   * The last time Recall refused a bot for want of credit. The balance is not exposed by the API, so
   * without this the first anyone hears of an empty account is a user whose meeting did not happen.
   */
  let lastCreditRefusalAt: number | null = null;

  const webhookDeps = () => ({
    store,
    client: recallClient(),
    transcriptLanguage: env.RECALL_TRANSCRIPT_LANGUAGE ?? "auto",
    log: (l: Record<string, unknown>) => console.log("[recall]", JSON.stringify(l)),
    // Push the state to whoever is connected, so nothing in the product has to ask Recall for it.
    onBotStatus: (st: { botId: string | null; status: string | null; subCode: string | null; event: string }) => {
      if (st.botId) relay.broadcast(st.botId, { event: "bot.status_change", data: { data: { code: st.status, sub_code: st.subCode } } });
    },
  });

  // ---- Calendar V2 (scheduling from the user's calendar) ---------------------------------------
  const calendarLog = (l: Record<string, unknown>) => console.log("[recall.calendar]", JSON.stringify(l));
  let armTimer: ReturnType<typeof setInterval> | null = null;
  const calendarStore = deps.calendarStore ?? new CalendarStore(env.RECALL_DATA_DIR, now);
  const calendarClient = () => new RecallCalendarClient({ apiKey: env.RECALL_API_KEY!, region: env.RECALL_REGION ?? "us-west-2", fetchImpl });
  const calendarSync = () =>
    new CalendarSync({
      client: calendarClient(),
      calendarStore,
      meetingStore: store,
      botConfig: calendarBotConfig(env, sessions, relay),
      now,
      log: calendarLog,
    });
  const calendarDeps = { client: calendarClient, store: calendarStore, sync: calendarSync, fetchImpl, log: calendarLog };

  if (deps.startWorker !== false && env.RECALL_API_KEY) {
    // `calendar.*` webhooks drive scheduling; everything else is the bot/recording/transcript lifecycle.
    queue.start((job) =>
      isCalendarEvent(job.event)
        ? handleCalendarWebhook(job.payload as { event?: string; data?: { calendar_id?: string; last_updated_ts?: string } }, calendarSync(), { client: calendarClient(), calendarStore, log: calendarLog })
        : handleWebhookJob(job, webhookDeps()),
    );
    /**
     * A calendar booking is made days ahead, but the bot page token lives 15 minutes, so the full
     * bot config is injected shortly before the meeting starts. `armDueEvents` is idempotent
     * (`armedAt`), so a missed tick is harmless and a restart simply re-checks.
     */
    const armEvery = Number(env.RECALL_CALENDAR_ARM_INTERVAL_MS ?? 60_000);
    armTimer = setInterval(() => {
      void calendarSync()
        .armDueEvents()
        .then((armed) => {
          for (const a of armed) calendarLog({ at: "arm", eventId: a.eventId, armed: a.armed, error: a.error });
        })
        .catch((e: unknown) => calendarLog({ at: "arm_failed", error: e instanceof Error ? e.message : "unknown" }));
    }, armEvery);
    armTimer.unref?.();
  }

  /**
   * Local dev origins, plus the bot page's public origin when the meeting connector is configured:
   * the Recall bot loads the app through a tunnel, so its Origin is not localhost.
   */
  const localOrigins = ["http://localhost:5173", "http://localhost:5178", "http://localhost:5180", "http://127.0.0.1:5173", "http://127.0.0.1:5178", "http://127.0.0.1:5180"];
  const botPageOrigin = (() => {
    try {
      return env.RECALL_BOT_PAGE_URL ? new URL(env.RECALL_BOT_PAGE_URL).origin : null;
    } catch {
      return null;
    }
  })();
  app.use("*", cors({
    origin: (origin) => (!origin || localOrigins.includes(origin) || origin === botPageOrigin ? origin ?? localOrigins[0] : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      providers: {
        openai: Boolean(env.OPENAI_API_KEY),
        google: Boolean(env.GEMINI_BACKEND === "vertex" ? env.GOOGLE_CLOUD_PROJECT : env.GEMINI_API_KEY),
        livekit: Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET),
        heygen: Boolean(env.HEYGEN_API_KEY),
        tavus: Boolean(env.TAVUS_API_KEY),
        recall: Boolean(env.RECALL_API_KEY),
      },
      meeting: {
        attendee: Boolean(env.ATTENDEE_API_KEY),
        recall: Boolean(env.RECALL_API_KEY),
        // Operational, not diagnostic: an empty Recall account looks like an outage from the outside.
        creditRefusedAt: lastCreditRefusalAt,
        recallPublicUrl: Boolean(env.RECALL_PUBLIC_URL),
        recallBotPageUrl: Boolean(env.RECALL_BOT_PAGE_URL),
        region: env.RECALL_REGION ?? "us-west-2",
        tokenSecret: sessions.secretSource,
      },
    }),
  );

  const json = async <T>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      return {} as T;
    }
  };

  // Fixed public news/weather sources only; no arbitrary URL fetching or credentials.
  app.post("/api/lookup", async (c) => {
    const req = parseLookupArguments((await json<Record<string, unknown>>(c)) ?? {});
    if (!req) return c.json({ error: "kind must be news or weather" }, 400);
    const result = await lookupLiveInfo(req, fetchImpl);
    return c.json(result.body, 200);
  });

  app.post("/api/session/openai-live", async (c) => {
    const r = await createOpenAILiveSession(env, await json(c), fetchImpl);
    return c.json(r.body, r.status as 200);
  });

  app.post("/api/token/openai", async (c) => {
    const r = await createOpenAIClientSecret(env, await json<OpenAITokenRequest>(c), fetchImpl);
    return c.json(r.body, r.status as 200);
  });

  app.post("/api/token/gemini", async (c) => {
    if (env.GEMINI_BACKEND === "vertex") {
      if (!env.GOOGLE_CLOUD_PROJECT) return c.json({ error: "BLOCKED_BY_VERTEX_PROJECT" }, 503);
      return c.json(vertex.mint());
    }
    const r = await createGeminiEphemeralToken(env, await json<{ model?: string }>(c), fetchImpl, now);
    return c.json(r.body, r.status as 200);
  });

  app.post("/api/evaluate", async (c) => {
    const body = await json<{ providerId?: "openai" | "google"; input?: EvaluationInput }>(c);
    if (!body.input) return c.json({ error: "input required" }, 400);
    /**
     * A malformed request is the caller's mistake (400), not an upstream failure (502) — returning 502
     * sent the UI looking for a provider outage that never happened. Checked after the key guards, so a
     * missing credential still reports as BLOCKED_BY_*, which the acceptance gates read.
     */
    /**
     * An exhausted account is not an outage. Reporting 429/quota as 502 sent the UI (and the soak
     * report) looking for a provider failure when the answer was "add credits" — the result screen
     * still falls back to the heuristic, but the reason has to be legible.
     */
    const evaluationFailure = (e: unknown, provider: "OPENAI" | "GEMINI") => {
      const detail = String((e as Error).message ?? e);
      const quota = /\b429\b|insufficient_quota|credit_balance_exhausted|RESOURCE_EXHAUSTED|quota/i.test(detail);
      return quota
        ? ({ body: { error: `BLOCKED_BY_${provider}_QUOTA`, detail }, status: 503 } as const)
        : ({ body: { error: "evaluation_failed", detail }, status: 502 } as const);
    };
    const badInput = (): string[] => (["mode", "transcript", "timing"] as const).filter((k) => body.input?.[k] === undefined);
    const mod = await loadEvaluationModule();
    if (body.providerId === "google") {
      if (env.GEMINI_BACKEND !== "vertex" && !env.GEMINI_API_KEY) return c.json({ error: "BLOCKED_BY_GEMINI_KEY" }, 503);
      if (!mod.evaluateWithGemini) return c.json({ ...fallbackHeuristic(body.input), evaluatedBy: "heuristic-fallback" });
      const badG = badInput();
      if (badG.length) return c.json({ error: "invalid_input", detail: `missing: ${badG.join(", ")}` }, 400);
      try {
        return c.json(await mod.evaluateWithGemini({ ...(env.GEMINI_BACKEND === "vertex" ? await vertex.evaluationAuth() : { apiKey: env.GEMINI_API_KEY }), model: env.GEMINI_EVAL_MODEL ?? (env.GEMINI_BACKEND === "vertex" ? "gemini-2.5-flash" : "gemini-3.6-flash"), fetch: fetchImpl }, body.input));
      } catch (e) {
        const f = evaluationFailure(e, "GEMINI");
        return c.json(f.body, f.status);
      }
    }
    if (!env.OPENAI_API_KEY) return c.json({ error: "BLOCKED_BY_OPENAI_KEY" }, 503);
    if (!mod.evaluateWithOpenAICompatible) return c.json({ ...fallbackHeuristic(body.input), evaluatedBy: "heuristic-fallback" });
    const badO = badInput();
    if (badO.length) return c.json({ error: "invalid_input", detail: `missing: ${badO.join(", ")}` }, 400);
    try {
      return c.json(await mod.evaluateWithOpenAICompatible({ baseUrl: "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY, model: env.OPENAI_EVAL_MODEL ?? "gpt-4.1-mini", fetch: fetchImpl }, body.input));
    } catch (e) {
      const f = evaluationFailure(e, "OPENAI");
      return c.json(f.body, f.status);
    }
  });

  app.post("/api/plan", async (c) => {
    const input = await json<MotionPlanInput>(c);
    if (typeof input.text !== "string") return c.json({ error: "text required" }, 400);
    const { plan, source } = await planWithOpenAI(env, { speaker: input.speaker ?? "assistant", text: input.text, mode: input.mode ?? "free_talk", language: input.language }, fetchImpl);
    c.header("x-plan-source", source);
    return c.json(plan);
  });

  app.post("/api/livekit/token", async (c) => {
    const r = await createLiveKitToken(env, await json<{ room?: string; identity?: string }>(c));
    return c.json(r.body, r.status as 200);
  });

  app.post("/api/avatar/heygen/session", async (c) => {
    const r = await createHeyGenSession(env, await json<Parameters<typeof createHeyGenSession>[1]>(c), fetchImpl);
    return c.json(r.body, r.status as 200);
  });

  app.post("/api/avatar/heygen/stop", async (c) => {
    const r = await stopHeyGenSession(env, await json<Parameters<typeof stopHeyGenSession>[1]>(c), fetchImpl);
    return c.json(r.body, r.status as 200);
  });

  app.post("/api/avatar/tavus/conversation", async (c) => {
    const r = await createTavusConversation(env, await json<Parameters<typeof createTavusConversation>[1]>(c), fetchImpl);
    return c.json(r.body, r.status as 200);
  });

  // ---- Meeting bots (Recall.ai) — the API key never leaves this process -------------------------
  app.post("/api/meeting/recall/bots", async (c) => {
    const r = await createRecallBot(env, await json<CreateBotBody>(c), fetchImpl, meetingDeps);
    if ((r.body as { error?: string }).error === "BLOCKED_BY_RECALL_CREDIT") lastCreditRefusalAt = now();
    return c.json(r.body, r.status as 200);
  });
  /**
   * Diagnostic and reconciliation only.
   *
   * Product state comes from webhooks. This asks Recall directly, which is what you want when a delivery
   * was missed and a meeting is stuck — and exactly what you do not want on a timer. Behind an admin
   * token so it cannot quietly become the product path again; without `RECALL_ADMIN_TOKEN` set it stays
   * open for local development.
   */
  const adminOnly = (c: { req: { header(n: string): string | undefined } }) =>
    !env.RECALL_ADMIN_TOKEN || c.req.header("x-admin-token") === env.RECALL_ADMIN_TOKEN;
  app.post("/api/meeting/recall/bots/:id/reconcile", async (c) => {
    if (!adminOnly(c)) return c.json({ error: "admin_token_required" }, 403);
    const r = await getRecallBot(env, c.req.param("id"), fetchImpl, meetingDeps);
    const body = r.body as { code?: string; subCode?: string | null };
    const rec = store.list(200).find((m) => m.botId === c.req.param("id"));
    if (rec && body.code) {
      const { shouldApplyStatus } = await import("./recall/botState.js");
      const apply = shouldApplyStatus(rec.status, body.code);
      if (apply) store.update(rec.id, { status: body.code as never, statusSubCode: body.subCode ?? null }, `reconcile:${body.code}`);
      return c.json({ ...body, reconciled: apply, meetingId: rec.id });
    }
    return c.json({ ...body, reconciled: false });
  });
  app.get("/api/meeting/recall/bots/:id", async (c) => {
    if (!adminOnly(c)) return c.json({ error: "admin_token_required" }, 403);
    const r = await getRecallBot(env, c.req.param("id"), fetchImpl, meetingDeps);
    return c.json(r.body, r.status as 200);
  });
  app.post("/api/meeting/recall/bots/:id/leave", async (c) => {
    const r = await leaveRecallBot(env, c.req.param("id"), fetchImpl, meetingDeps);
    return c.json(r.body, r.status as 200);
  });
  app.post("/api/meeting/recall/bots/:id/output_media/restart", async (c) => {
    const r = await restartOutputMedia(env, c.req.param("id"), fetchImpl, meetingDeps);
    return c.json(r.body, r.status as 200);
  });
  // Signed session lifecycle (Round 3 Gate 5)
  app.post("/api/meeting/session/activate", async (c) => {
    const body = await json<{ token?: string }>(c);
    const r = activateBotPage(env, sessions, body.token, relay);
    return c.json(r.body, r.status as 200);
  });
  app.get("/api/meeting/session/:id", (c) => {
    const r = getMeetingSession(sessions, c.req.param("id"), c.req.header("authorization"));
    return c.json(r.body, r.status as 200);
  });
  app.post("/api/meeting/session/:id/refresh", async (c) => {
    const r = refreshMeetingToken(env, sessions, c.req.param("id"), c.req.header("authorization"), await json<{ role?: "bot_page" | "client" | "relay" }>(c));
    return c.json(r.body, r.status as 200);
  });
  app.post("/api/meeting/session/:id/report", async (c) => {
    const body = await json<{ type?: string; data?: Record<string, unknown> }>(c);
    const r = reportFromBotPage(sessions, c.req.param("id"), c.req.header("authorization"), body);
    if (r.status === 200 && body.type === "ai_usage") {
      const botId = sessions.get(c.req.param("id"))?.botId;
      const data: Record<string, number> = {};
      for (const [key, value] of Object.entries(body.data ?? {})) if (["estimatedMicroUsd", "pricedTurns", "unpricedTurns", "contextPeakTokens", "inputAudioSeconds", "outputAudioSeconds", "imageCount", "liveActiveSeconds"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) data[key] = value;
      if (botId) relay.broadcast(botId, { trigger: "ai.usage", data });
      console.log(JSON.stringify({ event: "meeting_ai_usage", sessionId: c.req.param("id"), ...data }));
    }
    return c.json(r.body, r.status as 200);
  });
  /**
   * The character's live lookup (news / weather). Same authorisation as its reports: only the page
   * holding this session's client token may ask, and only for the two kinds the tool declares.
   */
  app.post("/api/meeting/session/:id/lookup", async (c) => {
    const auth = authorizeOperator(sessions, c.req.param("id"), c.req.header("authorization"));
    if (auth.status !== 200) return c.json(auth.body as Record<string, unknown>, auth.status as 200);
    const req = parseLookupArguments((await json<Record<string, unknown>>(c)) ?? {});
    if (!req) return c.json({ error: "kind must be news or weather" }, 400);
    const r = await lookupLiveInfo(req);
    return c.json(r.body as unknown as Record<string, unknown>, r.status as 200);
  });
  app.post("/api/meeting/session/:id/revoke", (c) => {
    const r = revokeMeetingSession(sessions, relay, c.req.param("id"), c.req.header("authorization"));
    return c.json(r.body, r.status as 200);
  });
  app.post("/api/meeting/recall/bots/:id/output_audio", async (c) => {
    const r = await outputRecallAudio(env, c.req.param("id"), await json<{ kind?: string; b64_data?: string }>(c), fetchImpl);
    return c.json(r.body, r.status as 200);
  });
  app.get("/api/meeting/recall/relay-status/:id", (c) => c.json({ botId: c.req.param("id"), ...relay.stats(c.req.param("id")) }));

  // ---- Calendar V2 -----------------------------------------------------------------------------
  /**
   * Customer-owned OAuth callback required by the Calendar V2 setup guide. It forwards exactly
   * `state`, `code`, `error` and `recall_calendar_setup_probe` to the regional callback and returns
   * that response verbatim, so Recall's probe and the mailbox authorization both succeed.
   */
  app.get("/api/meeting/calendar/oauth-callback", async (c) => {
    const r = await forwardCalendarCallback(env, new URL(c.req.url).searchParams, fetchImpl, calendarLog);
    return c.body(r.body, r.status as 200, { "content-type": r.contentType });
  });
  app.get("/api/calendar/status", async (c) => {
    const r = await calendarStatus(env, calendarDeps);
    return c.json(r.body, r.status as 200);
  });
  app.get("/api/calendar/events", async (c) => {
    const r = await calendarEvents(env, c.req.query("calendar_id"), calendarDeps);
    return c.json(r.body, r.status as 200);
  });
  app.post("/api/calendar/events/:id/optin", async (c) => {
    const r = await setEventOverride(env, c.req.param("id"), "opt_in", calendarDeps);
    return c.json(r.body, r.status as 200);
  });
  app.post("/api/calendar/events/:id/optout", async (c) => {
    const r = await setEventOverride(env, c.req.param("id"), "opt_out", calendarDeps);
    return c.json(r.body, r.status as 200);
  });
  app.get("/api/calendar/rule", (c) => {
    const r = getRule(calendarDeps);
    return c.json(r.body, r.status as 200);
  });
  app.put("/api/calendar/rule", async (c) => {
    const r = putRule(await json<{ markers?: unknown; leadMinutes?: unknown }>(c), calendarDeps);
    return c.json(r.body, r.status as 200);
  });

  /**
   * Dashboard (Svix) webhooks from Recall. Verify the RAW body first, enqueue, return 2xx fast —
   * Recall times out at 15 s and retries for 24 h, so no side effect happens in this handler.
   * Logs carry only the event type, ids and the verification outcome (never headers or bodies).
   */
  app.post("/api/recall/webhooks", async (c) => {
    const secret = env.RECALL_WEBHOOK_VERIFICATION_SECRET;
    if (!secret) return c.json({ error: "BLOCKED_BY_RECALL_WEBHOOK_SECRET" }, 503);
    const raw = await c.req.text();
    const headers = headerMap(c.req.raw);
    try {
      verifyRequestFromRecall({ secret, headers, payload: raw, now });
    } catch (e) {
      const reason = e instanceof RecallVerificationError ? e.reason : "invalid";
      console.warn("[recall] webhook rejected", JSON.stringify({ verified: false, reason }));
      return c.json({ error: "invalid_signature", reason }, 401);
    }
    let body: { event?: string } = {};
    try {
      body = JSON.parse(raw) as { event?: string };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const webhookId = headers["webhook-id"] ?? headers["svix-id"] ?? "";
    const fresh = queue.enqueue(webhookId, body.event ?? "unknown", body);
    console.log("[recall] webhook", JSON.stringify({ verified: true, event: body.event, webhookId, enqueued: fresh }));
    // Drain immediately when the worker is off (tests/smoke) so the effect is observable.
    if (deps.startWorker === false && fresh) await queue.drain((job) => handleWebhookJob(job, webhookDeps()));
    return c.json({ ok: true, duplicate: !fresh });
  });

  // Persisted product output: the meetings the bot attended and their transcripts.
  /** Operational: how much bot time is being spent. Cached; safe to poll from a dashboard. */
  const zoom = deps.zoom ?? (env.ZOOM_OAUTH_CLIENT_ID && env.ZOOM_OAUTH_CALLBACK_URL && env.ZOOM_OAUTH_WEB_ORIGIN && env.GOOGLE_CLOUD_PROJECT && env.ATTENDEE_API_KEY
    ? new ZoomConnections({ clientId: env.ZOOM_OAUTH_CLIENT_ID, callbackUrl: env.ZOOM_OAUTH_CALLBACK_URL, webOrigin: env.ZOOM_OAUTH_WEB_ORIGIN, attendeeKey: env.ATTENDEE_API_KEY, attendeeBase: env.ATTENDEE_API_BASE_URL }, new FirestoreZoomStore(env.GOOGLE_CLOUD_PROJECT, env.ZOOM_FIRESTORE_DATABASE), fetchImpl, now)
    : null);
  registerZoomRoutes(app, zoom);
  app.post("/api/meeting/attendee/bots", async (c) => {
    const { createAttendeeBot } = await import("./routes/attendee.js");
    const body = await json<import("./routes/attendee.js").AttendeeJoinBody>(c);
    let zoomUserId: string | undefined;
    let isZoom = false;
    try { const host = new URL(body.meetingUrl).hostname; isZoom = /(^|\.)zoom\.(us|com)$/.test(host); } catch { /* validated below */ }
    if (isZoom && (zoom || env.ZOOM_REQUIRE_AUTH === "1" || bearer(c))) {
      if (!zoom) return c.json({ error: "ZOOM_NOT_CONFIGURED" }, 503);
      try { zoomUserId = await zoom.authorize(bearer(c)); }
      catch (e) { return c.json({ error: e instanceof ZoomAuthError ? e.code : "ZOOM_CONNECTION_UNAVAILABLE" }, e instanceof ZoomAuthError ? e.status as 401 : 503); }
    }
    const r = await createAttendeeBot(env, body, fetchImpl, { relay, sessions, store, zoomUserId });
    if ((r.body as { error?: string }).error === "BLOCKED_BY_ATTENDEE_CREDIT") lastCreditRefusalAt = now();
    return c.json(r.body, r.status as 200);
  });

  /**
   * Attendee's bot state. Verified, then applied monotonically like Recall's — a late delivery must not
   * drag a live meeting backwards. Without a configured secret the signature cannot be checked, so the
   * delivery is recorded as unverified rather than silently trusted.
   */
  const observerDeliveries = new Map<string, Set<string>>();
  app.post("/api/attendee/observer/:token", async c => {
    const payload = await json<Record<string, unknown>>(c);
    if (typeof payload.bot_id !== "string") return c.json({ error: "bot_required" }, 400);
    const auth = sessions.verify(c.req.param("token"), { role: "observer", botId: payload.bot_id });
    if (!auth.ok) return c.json({ error: "invalid_observer" }, 401);
    const { observerCaption } = await import("./routes/observer.js");
    const caption = observerCaption(payload);
    if (!caption) return c.json({ error: "invalid_caption" }, 400);
    if (typeof payload.idempotency_key !== "string") return c.json({ error: "delivery_id_required" }, 400);
    for (const sid of observerDeliveries.keys()) { const s = sessions.get(sid); if (!s || s.ended || s.revoked) observerDeliveries.delete(sid); }
    const seen = observerDeliveries.get(auth.session.id) ?? new Set<string>();
    if (seen.has(payload.idempotency_key)) return c.json({ ok: true, duplicate: true });
    const sent = relay.broadcast(payload.bot_id, caption);
    // Retry until the page is connected instead of silently losing the wake word.
    if (!sent) return c.json({ error: "observer_not_connected" }, 503);
    seen.add(payload.idempotency_key);
    if (seen.size > 2000) seen.delete(seen.values().next().value!);
    observerDeliveries.set(auth.session.id, seen);
    return c.json({ ok: true });
  });
  app.post("/api/attendee/webhooks", async (c) => {
    const { handleAttendeeWebhook, sendAttendeeJoinNotice, verifyAttendeeSignature } = await import("./routes/attendeeWebhooks.js");
    const payload = await json<Record<string, unknown>>(c);
    const secret = env.ATTENDEE_WEBHOOK_SECRET;
    const verified = secret ? verifyAttendeeSignature(payload, c.req.header("x-webhook-signature"), secret) : null;
    if (verified === false) return c.json({ error: "invalid_signature" }, 401);
    const r = handleAttendeeWebhook(payload, {
      store,
      log: (l) => console.log("[attendee]", JSON.stringify({ ...l, verified })),
      onBotStatus: (st) => relay.broadcast(st.botId, { event: "bot.status_change", data: { data: { code: st.status, sub_code: st.subCode } } }),
      onJoined: (botId) => void sendAttendeeJoinNotice(env, botId, fetchImpl).then((sent) => console.log("[attendee]", JSON.stringify({ at: "join_notice", botId, sent }))),
    });
    return c.json(r);
  });
  app.post("/api/meeting/attendee/bots/:id/leave", async (c) => {
    const { leaveAttendeeBot } = await import("./routes/attendee.js");
    const r = await leaveAttendeeBot(env, c.req.param("id"), fetchImpl, { relay, sessions });
    return c.json(r.body, r.status as 200);
  });
  app.get("/api/recall/usage", async (c) => {
    const { recallUsage } = await import("./recall/balance.js");
    const u = await recallUsage(env, fetchImpl);
    return c.json(u, "error" in u ? 503 : 200);
  });
  app.get("/api/meetings", (c) => c.json({ meetings: store.list(Number(c.req.query("limit") ?? 100)) }));
  app.get("/api/meetings/:id", (c) => {
    const rec = store.get(c.req.param("id"));
    if (!rec) return c.json({ error: "not_found" }, 404);
    const transcript = store.readTranscript(rec);
    return c.json({ meeting: rec, transcript: transcript ? { text: transcript.text } : null });
  });
  app.get("/api/meetings/:id/transcript", (c) => {
    const rec = store.get(c.req.param("id"));
    if (!rec) return c.json({ error: "not_found" }, 404);
    const t = store.readTranscript(rec);
    if (!t) return c.json({ error: "transcript_not_ready", transcriptId: rec.transcriptId ?? null, transcriptError: rec.transcriptError ?? null }, 404);
    return c.json({ meetingId: rec.id, text: t.text, data: t.json });
  });

  // Human Reality Gate observations (docs/human-gate.md) → docs/reports/human/<date>.jsonl
  app.post("/api/feedback", async (c) => {
    const r = await recordFeedback(await json<{ entries?: FeedbackEntry[] }>(c), deps.feedbackDir ? { dir: deps.feedbackDir } : {});
    return c.json(r.body, r.status as 200);
  });

  // Presence incidents (Round 3 Gate 6) → docs/reports/human/incidents/<sessionId>/<id>.json (+ opt-in media files)
  app.post("/api/incidents", async (c) => {
    const r = await recordIncident(await json<IncidentBody>(c), deps.incidentsDir ? { dir: deps.incidentsDir } : {});
    return c.json(r.body, r.status as 200);
  });

  // Session telemetry (Round 3 Gate 7): numbers only — any content-like key is rejected with 400.
  app.post("/api/telemetry", async (c) => {
    const r = await recordTelemetry(await json<unknown>(c), deps.telemetryDir ? { dir: deps.telemetryDir } : {});
    return c.json(r.body, r.status as 200);
  });

  // Let callers (tests, shutdown) stop the background timer deterministically.
  (app as unknown as { stopCalendarTimer?: () => void }).stopCalendarTimer = () => {
    if (armTimer) clearInterval(armTimer);
    armTimer = null;
  };
  return app;
}
