import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { RecallApiError, RecallClient } from "./client.js";
import { MeetingStore, toReadableTranscript } from "./store.js";
import { WebhookQueue } from "./queue.js";
import { RecallVerificationError, signLikeRecall, verifyRequestFromRecall } from "./verify.js";
import { handleWebhookJob } from "../routes/webhooks.js";

/** A fake secret with the real shape — no real credential is ever used in tests. */
const SECRET = `whsec_${Buffer.from("test-verification-key-0123456789").toString("base64")}`;
const OTHER = `whsec_${Buffer.from("a-different-key-0123456789012345").toString("base64")}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rcai-recall-"));
}

function signed(body: string, opts: { secret?: string; id?: string; ts?: string } = {}) {
  const id = opts.id ?? "msg_test_1";
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  return {
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": signLikeRecall(opts.secret ?? SECRET, id, ts, body),
  };
}

describe("verifyRequestFromRecall", () => {
  const body = JSON.stringify({ event: "recording.done" });

  it("accepts a correctly signed request", () => {
    expect(() => verifyRequestFromRecall({ secret: SECRET, headers: signed(body), payload: body })).not.toThrow();
  });

  it("accepts svix-* header aliases", () => {
    const h = signed(body);
    const legacy = { "svix-id": h["webhook-id"], "svix-timestamp": h["webhook-timestamp"], "svix-signature": h["webhook-signature"] };
    expect(() => verifyRequestFromRecall({ secret: SECRET, headers: legacy, payload: body })).not.toThrow();
  });

  it("accepts when one of several space-separated signatures matches (rotation)", () => {
    const h = signed(body);
    h["webhook-signature"] = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${h["webhook-signature"]}`;
    expect(() => verifyRequestFromRecall({ secret: SECRET, headers: h, payload: body })).not.toThrow();
  });

  it("rejects a wrong secret, tampered body, missing headers and a stale timestamp", () => {
    expect(() => verifyRequestFromRecall({ secret: OTHER, headers: signed(body), payload: body })).toThrow(RecallVerificationError);
    expect(() => verifyRequestFromRecall({ secret: SECRET, headers: signed(body), payload: body + " " })).toThrow(/no_matching_signature/);
    expect(() => verifyRequestFromRecall({ secret: SECRET, headers: {}, payload: body })).toThrow(/missing_headers/);
    const old = String(Math.floor(Date.now() / 1000) - 4000);
    expect(() => verifyRequestFromRecall({ secret: SECRET, headers: signed(body, { ts: old }), payload: body })).toThrow(/stale_timestamp/);
    expect(() => verifyRequestFromRecall({ secret: "not-a-secret", headers: signed(body), payload: body })).toThrow(/missing_secret/);
  });

  it("verifies a body-less request (GET / websocket upgrade)", () => {
    const h = signed("");
    expect(() => verifyRequestFromRecall({ secret: SECRET, headers: h, payload: null })).not.toThrow();
  });
});

describe("RecallClient", () => {
  it("binds the region, sends the raw Authorization header and parses JSON", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new RecallClient({
      apiKey: "fake-key",
      region: "ap-northeast-1",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ id: "bot_1" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const bot = await client.createBot({ meeting_url: "https://meet.google.com/abc-defg-hij", bot_name: "Yui" });
    expect(bot.id).toBe("bot_1");
    expect(calls[0]!.url).toBe("https://ap-northeast-1.recall.ai/api/v1/bot/");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("fake-key");
  });

  it("honours Retry-After on 429 and then succeeds", async () => {
    const waits: number[] = [];
    let n = 0;
    const client = new RecallClient({
      apiKey: "fake-key",
      region: "ap-northeast-1",
      sleep: async (ms) => void waits.push(ms),
      random: () => 0.5,
      fetchImpl: (async () => {
        n++;
        if (n === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
        return new Response(JSON.stringify({ id: "t_1" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const t = await client.createTranscript("rec_1");
    expect(t.id).toBe("t_1");
    expect(waits).toEqual([2000]);
  });

  it("backs off with jitter on 503 and gives up as a typed error", async () => {
    const waits: number[] = [];
    const client = new RecallClient({
      apiKey: "fake-key",
      region: "ap-northeast-1",
      maxRetries: 2,
      sleep: async (ms) => void waits.push(ms),
      random: () => 0,
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(client.retrieveBot("bot_1")).rejects.toBeInstanceOf(RecallApiError);
    expect(waits.length).toBe(2);
    expect(waits[0]).toBeLessThan(waits[1]!);
  });

  it("sends the documented async transcript body", async () => {
    let sent: unknown = null;
    const client = new RecallClient({
      apiKey: "k",
      region: "ap-northeast-1",
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        sent = JSON.parse(String(init!.body));
        return new Response(JSON.stringify({ id: "t_9" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.createTranscript("rec_9", "auto");
    expect(sent).toEqual({ provider: { recallai_async: { language_code: "auto" } }, diarization: { use_separate_streams_when_available: true } });
  });
});

describe("MeetingStore", () => {
  it("persists the intent before a bot exists and reconciles it", () => {
    const store = new MeetingStore(tmp());
    const rec = store.createIntent({ meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Yui" });
    expect(rec.status).toBe("intent");
    expect(rec.platform).toBe("google_meet");
    expect(store.unreconciled(rec.meetingUrl)).toHaveLength(1);
    store.update(rec.id, { botId: "bot_7", status: "joining_call" }, "bot_created");
    expect(store.unreconciled(rec.meetingUrl)).toHaveLength(0);
    expect(store.byBot("bot_7")!.id).toBe(rec.id);
  });

  it("writes atomically and survives a reload", () => {
    const dir = tmp();
    const a = new MeetingStore(dir);
    const rec = a.createIntent({ meetingUrl: "https://zoom.us/j/123" });
    a.update(rec.id, { status: "in_call_recording", recordingId: "rec_1" }, "bot.in_call_recording");
    const b = new MeetingStore(dir);
    const loaded = b.get(rec.id)!;
    expect(loaded.status).toBe("in_call_recording");
    expect(loaded.platform).toBe("zoom");
    expect(loaded.lifecycle.map((l) => l.event)).toEqual(["intent", "bot.in_call_recording"]);
  });

  it("renders a readable transcript from the download payload", () => {
    const text = toReadableTranscript([
      { participant: { name: "Yui" }, words: [{ text: "こんにちは", start_timestamp: { relative: 5 } }, { text: "。" }] },
      { participant: { name: "Shuhei" }, words: [{ text: "hello", start_timestamp: { relative: 65 } }] },
    ]);
    expect(text).toBe("[00:05] Yui: こんにちは。\n[01:05] Shuhei: hello");
  });
});

describe("WebhookQueue", () => {
  it("is idempotent on webhook-id and drops replays before any side effect", async () => {
    const q = new WebhookQueue({ dir: join(tmp(), "queue") });
    expect(q.enqueue("msg_1", "recording.done", { event: "recording.done" })).toBe(true);
    expect(q.enqueue("msg_1", "recording.done", { event: "recording.done" })).toBe(true); // still pending, not yet processed
    let handled = 0;
    await q.drain(async () => void handled++);
    expect(handled).toBe(1); // second copy dropped once the first marked the id processed
    expect(q.enqueue("msg_1", "recording.done", {})).toBe(false);
    await q.drain(async () => void handled++);
    expect(handled).toBe(1);
  });

  it("retries with backoff and dead-letters after maxAttempts", async () => {
    const q = new WebhookQueue({ dir: join(tmp(), "queue"), maxAttempts: 2, backoff: () => 0 });
    q.enqueue("msg_2", "transcript.done", {});
    await q.drain(async () => {
      throw new Error("boom");
    });
    expect(q.pendingCount).toBe(1);
    await q.drain(async () => {
      throw new Error("boom");
    });
    expect(q.pendingCount).toBe(0);
    expect(q.deadCount).toBe(1);
  });
});

describe("handleWebhookJob", () => {
  const base = { attempts: 0, enqueuedAt: new Date().toISOString(), nextAttemptAt: 0, id: "job_1" };

  it("recording.done creates exactly one async transcript and records its id", async () => {
    const store = new MeetingStore(tmp());
    const rec = store.createIntent({ meetingUrl: "https://meet.google.com/x" });
    store.update(rec.id, { botId: "bot_1" }, "bot_created");
    const calls: string[] = [];
    const client = new RecallClient({
      apiKey: "k",
      region: "ap-northeast-1",
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ id: "t_1" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const payload = { event: "recording.done", data: { recording: { id: "rec_1" }, bot: { id: "bot_1" } } };
    await handleWebhookJob({ ...base, webhookId: "m1", event: "recording.done", payload }, { store, client });
    expect(calls).toEqual(["https://ap-northeast-1.recall.ai/api/v1/recording/rec_1/create_transcript/"]);
    expect(store.get(rec.id)!.transcriptId).toBe("t_1");

    // A replay of the same recording must not create a second transcript.
    await handleWebhookJob({ ...base, webhookId: "m2", event: "recording.done", payload }, { store, client });
    expect(calls).toHaveLength(1);
  });

  it("transcript.done retrieves, downloads and persists the transcript", async () => {
    const store = new MeetingStore(tmp());
    const rec = store.createIntent({ meetingUrl: "https://meet.google.com/x" });
    store.update(rec.id, { botId: "bot_1", recordingId: "rec_1", transcriptId: "t_1" }, "transcript.requested");
    const client = new RecallClient({
      apiKey: "k",
      region: "ap-northeast-1",
      fetchImpl: (async (url: string) => {
        if (url.endsWith("/transcript/t_1/")) return new Response(JSON.stringify({ id: "t_1", data: { download_url: "https://files.example/t_1.json" } }), { status: 200 });
        if (url === "https://files.example/t_1.json") {
          return new Response(JSON.stringify([{ participant: { name: "Yui" }, words: [{ text: "ありがとうございました", start_timestamp: { relative: 1 } }] }]), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      }) as unknown as typeof fetch,
    });
    await handleWebhookJob({ ...base, webhookId: "m3", event: "transcript.done", payload: { event: "transcript.done", data: { transcript: { id: "t_1" } } } }, { store, client });
    const saved = store.get(rec.id)!;
    expect(saved.transcriptPath).toBe(`transcripts/${rec.id}.json`);
    const t = store.readTranscript(saved)!;
    expect(t.text).toContain("Yui: ありがとうございました");
    expect(existsSync(join(store.root, saved.transcriptTextPath!))).toBe(true);
  });

  it("bot.* updates lifecycle and transcript.failed records the sub_code", async () => {
    const store = new MeetingStore(tmp());
    const rec = store.createIntent({ meetingUrl: "https://meet.google.com/x" });
    store.update(rec.id, { botId: "bot_1", transcriptId: "t_1" }, "bot_created");
    const client = new RecallClient({ apiKey: "k", region: "ap-northeast-1", fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch });
    await handleWebhookJob(
      { ...base, webhookId: "m4", event: "bot.in_waiting_room", payload: { event: "bot.in_waiting_room", data: { bot: { id: "bot_1" }, data: { code: "in_waiting_room", sub_code: null } } } },
      { store, client },
    );
    expect(store.get(rec.id)!.status).toBe("in_waiting_room");
    await handleWebhookJob(
      { ...base, webhookId: "m5", event: "transcript.failed", payload: { event: "transcript.failed", data: { transcript: { id: "t_1" }, status: { sub_code: "provider_error" } } } },
      { store, client },
    );
    expect(store.get(rec.id)!.transcriptError).toBe("provider_error");
  });
});

describe("POST /api/recall/webhooks", () => {
  const envBase = { RECALL_API_KEY: "fake-key", RECALL_REGION: "ap-northeast-1", RECALL_WEBHOOK_VERIFICATION_SECRET: SECRET };

  function app(dir: string, fetchImpl: typeof fetch) {
    const store = new MeetingStore(dir);
    const queue = new WebhookQueue({ dir: join(dir, "queue") });
    return { app: createApp({ env: envBase, fetch: fetchImpl, store, queue, startWorker: false }), store, queue };
  }

  it("rejects an unsigned or badly signed request without processing it", async () => {
    const dir = tmp();
    let called = false;
    const { app: a } = app(dir, (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    const body = JSON.stringify({ event: "recording.done", data: { recording: { id: "rec_1" } } });
    const res = await a.request("/api/recall/webhooks", { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
    const res2 = await a.request("/api/recall/webhooks", { method: "POST", body, headers: { "content-type": "application/json", ...signed(body, { secret: OTHER }) } });
    expect(res2.status).toBe(401);
    expect(called).toBe(false);
  });

  it("verifies, processes once, and treats a redelivery as a duplicate", async () => {
    const dir = tmp();
    const calls: string[] = [];
    const { app: a, store } = app(dir, (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ id: "t_1" }), { status: 200 });
    }) as unknown as typeof fetch);
    const rec = store.createIntent({ meetingUrl: "https://meet.google.com/abc" });
    store.update(rec.id, { botId: "bot_1" }, "bot_created");

    const body = JSON.stringify({ event: "recording.done", data: { recording: { id: "rec_1" }, bot: { id: "bot_1" } } });
    const headers = { "content-type": "application/json", ...signed(body, { id: "msg_dup" }) };
    const first = await a.request("/api/recall/webhooks", { method: "POST", body, headers });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false });
    expect(store.get(rec.id)!.transcriptId).toBe("t_1");

    const second = await a.request("/api/recall/webhooks", { method: "POST", body, headers });
    expect(await second.json()).toEqual({ ok: true, duplicate: true });
    expect(calls).toHaveLength(1);
  });

  it("exposes the persisted meeting + transcript through the product API", async () => {
    const dir = tmp();
    const { app: a, store } = app(dir, (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
    const rec = store.createIntent({ meetingUrl: "https://meet.google.com/abc" });
    const paths = store.saveTranscript(rec.id, [{ participant: { name: "Yui" }, words: [{ text: "はい" }] }], "Yui: はい");
    store.update(rec.id, { ...paths, status: "done" }, "transcript.done");

    const list = (await (await a.request("/api/meetings")).json()) as { meetings: { id: string }[] };
    expect(list.meetings[0]!.id).toBe(rec.id);
    const detail = (await (await a.request(`/api/meetings/${rec.id}`)).json()) as { transcript: { text: string } };
    expect(detail.transcript.text).toBe("Yui: はい");
    const t = (await (await a.request(`/api/meetings/${rec.id}/transcript`)).json()) as { text: string };
    expect(t.text).toBe("Yui: はい");
  });

  it("returns 503 when the verification secret is not configured", async () => {
    const a = createApp({ env: { RECALL_API_KEY: "k" }, store: new MeetingStore(tmp()), queue: new WebhookQueue({ dir: join(tmp(), "q") }), startWorker: false });
    const res = await a.request("/api/recall/webhooks", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "BLOCKED_BY_RECALL_WEBHOOK_SECRET" });
  });
});

describe("create bot scheduling path", () => {
  it("persists the intent before the Create Bot call and reconciles an ambiguous failure", async () => {
    const dir = tmp();
    const store = new MeetingStore(dir);
    const order: string[] = [];
    const failing = (async () => {
      order.push(`create:intents=${store.list().length}`);
      return new Response("upstream exploded", { status: 500 });
    }) as unknown as typeof fetch;
    const a = createApp({
      env: { RECALL_API_KEY: "k", RECALL_REGION: "ap-northeast-1", RECALL_PUBLIC_URL: "https://broker.example", RECALL_BOT_PAGE_URL: "https://web.example", MEETING_TOKEN_SECRET: "0123456789abcdef0123" },
      fetch: failing,
      store,
      queue: new WebhookQueue({ dir: join(dir, "queue") }),
      startWorker: false,
    });
    const res = await a.request("/api/meeting/recall/bots", {
      method: "POST",
      body: JSON.stringify({ meetingUrl: "https://meet.google.com/abc-defg-hij" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(502);
    // The intent existed before the request went out, and the failure is recorded, not retried blindly.
    expect(order).toEqual(["create:intents=1"]);
    const rec = store.list()[0]!;
    expect(rec.status).toBe("create_failed");
    expect(rec.lifecycle.map((l) => l.event)).toEqual(["intent", "creating", "create_failed"]);
  });

  it("sends join_at + meetingRecordId metadata and binds the bot id", async () => {
    const dir = tmp();
    const store = new MeetingStore(dir);
    let sent: Record<string, unknown> = {};
    const ok = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/bot/")) {
        sent = JSON.parse(String(init!.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ id: "bot_42", status_changes: [{ code: "joining_call" }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const a = createApp({
      env: { RECALL_API_KEY: "k", RECALL_REGION: "ap-northeast-1", RECALL_PUBLIC_URL: "https://broker.example", RECALL_BOT_PAGE_URL: "https://web.example", MEETING_TOKEN_SECRET: "0123456789abcdef0123" },
      fetch: ok,
      store,
      queue: new WebhookQueue({ dir: join(dir, "queue") }),
      startWorker: false,
    });
    const res = await a.request("/api/meeting/recall/bots", {
      method: "POST",
      body: JSON.stringify({ meetingUrl: "https://meet.google.com/abc-defg-hij", joinAt: "2026-09-01T02:00:00.000Z", calendarEventId: "evt_1" }),
      headers: { "content-type": "application/json" },
    });
    const body = (await res.json()) as { botId: string; meetingRecordId: string };
    expect(body.botId).toBe("bot_42");
    expect(sent.join_at).toBe("2026-09-01T02:00:00.000Z");
    expect((sent.metadata as Record<string, string>).meetingRecordId).toBe(body.meetingRecordId);
    const rec = store.get(body.meetingRecordId)!;
    expect(rec.botId).toBe("bot_42");
    expect(rec.source).toBe("calendar");
    expect(rec.calendarEventId).toBe("evt_1");
    expect(rec.scheduledFor).toBe("2026-09-01T02:00:00.000Z");
  });
});
