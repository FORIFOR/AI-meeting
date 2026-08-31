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
import { activateBotPage, createRecallBot, getMeetingSession, getRecallBot, leaveRecallBot, outputRecallAudio, refreshMeetingToken, restartOutputMedia, revokeMeetingSession, type CreateBotBody } from "./routes/meeting.js";
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
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const relay = deps.relay ?? new RelayHub(deps.clientWsBase ?? `ws://localhost:${env.PORT ?? 8787}`, now);
  const sessions = deps.sessions ?? new MeetingSessionRegistry(env.MEETING_TOKEN_SECRET, now);
  const app = new Hono();

  // ---- Recall durable lifecycle (store + webhook queue) ----------------------------------------
  const store = deps.store ?? new MeetingStore(env.RECALL_DATA_DIR, now);
  const meetingDeps = { relay, sessions, store };
  const queue = deps.queue ?? new WebhookQueue({ dir: env.RECALL_DATA_DIR ? `${env.RECALL_DATA_DIR}/queue` : undefined, now });
  const recallClient = () => new RecallClient({ apiKey: env.RECALL_API_KEY!, region: env.RECALL_REGION ?? "us-west-2", fetchImpl });
  const webhookDeps = () => ({ store, client: recallClient(), transcriptLanguage: env.RECALL_TRANSCRIPT_LANGUAGE ?? "auto", log: (l: Record<string, unknown>) => console.log("[recall]", JSON.stringify(l)) });

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
        google: Boolean(env.GEMINI_API_KEY),
        livekit: Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET),
        heygen: Boolean(env.HEYGEN_API_KEY),
        tavus: Boolean(env.TAVUS_API_KEY),
        recall: Boolean(env.RECALL_API_KEY),
      },
      meeting: {
        recall: Boolean(env.RECALL_API_KEY),
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

  app.post("/api/token/openai", async (c) => {
    const r = await createOpenAIClientSecret(env, await json<OpenAITokenRequest>(c), fetchImpl);
    return c.json(r.body, r.status as 200);
  });

  app.post("/api/token/gemini", async (c) => {
    const r = await createGeminiEphemeralToken(env, await json<{ model?: string }>(c), fetchImpl, now);
    return c.json(r.body, r.status as 200);
  });

  app.post("/api/evaluate", async (c) => {
    const body = await json<{ providerId?: "openai" | "google"; input?: EvaluationInput }>(c);
    if (!body.input) return c.json({ error: "input required" }, 400);
    const mod = await loadEvaluationModule();
    if (body.providerId === "google") {
      if (!env.GEMINI_API_KEY) return c.json({ error: "BLOCKED_BY_GEMINI_KEY" }, 503);
      if (!mod.evaluateWithGemini) return c.json({ ...fallbackHeuristic(body.input), evaluatedBy: "heuristic-fallback" });
      try {
        return c.json(await mod.evaluateWithGemini({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_EVAL_MODEL ?? "gemini-2.5-flash", fetch: fetchImpl }, body.input));
      } catch (e) {
        return c.json({ error: "evaluation_failed", detail: String((e as Error).message) }, 502);
      }
    }
    if (!env.OPENAI_API_KEY) return c.json({ error: "BLOCKED_BY_OPENAI_KEY" }, 503);
    if (!mod.evaluateWithOpenAICompatible) return c.json({ ...fallbackHeuristic(body.input), evaluatedBy: "heuristic-fallback" });
    try {
      return c.json(await mod.evaluateWithOpenAICompatible({ baseUrl: "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY, model: env.OPENAI_EVAL_MODEL ?? "gpt-4.1-mini", fetch: fetchImpl }, body.input));
    } catch (e) {
      return c.json({ error: "evaluation_failed", detail: String((e as Error).message) }, 502);
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
    return c.json(r.body, r.status as 200);
  });
  app.get("/api/meeting/recall/bots/:id", async (c) => {
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
    const r = activateBotPage(sessions, body.token, relay);
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
  app.post("/api/meeting/session/:id/revoke", (c) => {
    const r = revokeMeetingSession(sessions, relay, c.req.param("id"), c.req.header("authorization"));
    return c.json(r.body, r.status as 200);
  });
  app.post("/api/meeting/recall/bots/:id/output_audio", async (c) => {
    const r = await outputRecallAudio(env, c.req.param("id"), await json<{ kind?: string; b64_data?: string }>(c), fetchImpl);
    return c.json(r.body, r.status as 200);
  });
  app.get("/api/meeting/recall/relay-status/:id", (c) => c.json({ botId: c.req.param("id"), clients: relay.clientCount(c.req.param("id")) }));

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
