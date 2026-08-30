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
}

export function createApp(deps: AppDeps): Hono {
  const env = deps.env;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const relay = deps.relay ?? new RelayHub(deps.clientWsBase ?? `ws://localhost:${env.PORT ?? 8787}`, now);
  const sessions = deps.sessions ?? new MeetingSessionRegistry(env.MEETING_TOKEN_SECRET, now);
  const meetingDeps = { relay, sessions };
  const app = new Hono();

  app.use("*", cors({ origin: ["http://localhost:5173", "http://localhost:5178", "http://localhost:5180", "http://127.0.0.1:5173", "http://127.0.0.1:5178", "http://127.0.0.1:5180"], allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type"] }));

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

  return app;
}
