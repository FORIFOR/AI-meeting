import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrokerEnv } from "../env.js";
import { ANAM_SESSION_TIMEOUT_MS, anamAvailability, createAnamSession } from "./anam.js";

const avatarId = "c4b9a21f-1df2-41c1-99d0-531b670b51d7";
const env: BrokerEnv = { ANAM_API_KEY: "private-anam-test-key", ANAM_AVATAR_IDS: JSON.stringify({ yui: avatarId }) };
const request = { characterId: "yui", privacyMode: "default" };
const tokenResponse = () => new Response(JSON.stringify({ sessionToken: "short-lived-test-token", privateConfig: env }));

afterEach(() => vi.useRealTimers());

describe("Anam session token", () => {
  it("uses only the server character mapping and model, disables replay, and returns only a session token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => tokenResponse());
    expect(await createAnamSession(env, request, fetcher)).toEqual({ status: 200, body: { sessionToken: "short-lived-test-token" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.anam.ai/v1/auth/session-token");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer private-anam-test-key", "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      personaConfig: { avatarId, avatarModel: "cara-4", enableAudioPassthrough: true },
      sessionOptions: { sessionReplay: { enableSessionReplay: false } },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("accepts a deployment model override without a browser override", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => tokenResponse());
    await createAnamSession({ ...env, ANAM_AVATAR_MODEL: "cara-3" }, { characterId: "yui" }, fetcher);
    expect(JSON.parse(fetcher.mock.calls[0]![1]?.body as string).personaConfig.avatarModel).toBe("cara-3");
  });

  it.each([
    null, [], "yui", {}, { characterId: 2 }, { characterId: "../yui" },
    { characterId: "yui", avatarId }, { characterId: "yui", avatarModel: "cara-3" },
    { characterId: "yui", personaConfig: { avatarId } }, { characterId: "yui", privacyMode: "anything" },
  ])("rejects malformed or client-controlled configuration before contacting Anam: %j", async (body) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await createAnamSession(env, body, fetcher)).toEqual({ status: 400, body: { error: "invalid_anam_session" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("blocks strict_local before credentials or network access", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await createAnamSession({}, { characterId: "yui", privacyMode: "strict_local" }, fetcher))
      .toEqual({ status: 403, body: { error: "BLOCKED_BY_STRICT_LOCAL" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("blocks unavailable credentials and unmapped characters without choosing a different face", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await createAnamSession({ ...env, ANAM_API_KEY: " " }, request, fetcher))
      .toEqual({ status: 503, body: { error: "BLOCKED_BY_ANAM_KEY" } });
    expect(await createAnamSession(env, { characterId: "haru" }, fetcher))
      .toEqual({ status: 503, body: { error: "BLOCKED_BY_ANAM_CHARACTER" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, "{broken", "null", "[]", "{}", '{"yui":"not-a-uuid"}', JSON.stringify({ yui: avatarId, haru: "bad" })])(
    "fails closed for absent or invalid server mappings: %s", async (mapping) => {
      const fetcher = vi.fn<typeof fetch>();
      const invalid = { ...env, ANAM_AVATAR_IDS: mapping };
      expect(await createAnamSession(invalid, request, fetcher)).toEqual({ status: 503, body: { error: "BLOCKED_BY_ANAM_AVATAR_CONFIG" } });
      expect(anamAvailability(invalid)).toEqual({ configured: false, characterIds: [] });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("blocks invalid server model configuration", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await createAnamSession({ ...env, ANAM_AVATAR_MODEL: "../invalid model" }, request, fetcher))
      .toEqual({ status: 503, body: { error: "BLOCKED_BY_ANAM_AVATAR_CONFIG" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])("sanitizes upstream HTTP %s and never retries", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(`upstream echo ${env.ANAM_API_KEY}`, { status }));
    const result = await createAnamSession(env, request, fetcher);
    expect(result.status).toBe(status === 401 || status === 403 ? 503 : 502);
    expect(result.body).toEqual({ error: status === 401 || status === 403 ? "BLOCKED_BY_ANAM_KEY" : "anam_session_failed" });
    expect(JSON.stringify(result)).not.toContain(env.ANAM_API_KEY);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("sanitizes fetch exceptions and malformed upstream JSON", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(`upstream echo ${env.ANAM_API_KEY}`))
      .mockResolvedValueOnce(new Response(`not JSON ${env.ANAM_API_KEY}`));
    expect(await createAnamSession(env, request, fetcher)).toEqual({ status: 502, body: { error: "anam_session_failed" } });
    expect(await createAnamSession(env, request, fetcher)).toEqual({ status: 502, body: { error: "anam_session_failed" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { sessionToken: " " }, { sessionToken: 42 }, { sessionToken: env.ANAM_API_KEY }])(
    "does not forward invalid tokens or an echoed long-lived key", async (body) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
      expect(await createAnamSession(env, request, fetcher)).toEqual({ status: 502, body: { error: "invalid_anam_session_token" } });
    },
  );

  it.each(["headers", "body"])("bounds stalled upstream %s within eight seconds and aborts the request", async (phase) => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => phase === "headers"
      ? never : { ok: true, json: () => never } as unknown as Response);
    const pending = createAnamSession(env, request, fetcher);
    await vi.advanceTimersByTimeAsync(ANAM_SESSION_TIMEOUT_MS);
    expect(await pending).toEqual({ status: 504, body: { error: "anam_session_timeout" } });
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout after a successful response", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => tokenResponse());
    await createAnamSession(env, request, fetcher);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(ANAM_SESSION_TIMEOUT_MS);
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(false);
  });
});
