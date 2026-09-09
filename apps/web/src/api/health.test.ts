import { afterEach, describe, expect, it, vi } from "vitest";
import { probe, shouldProbeLocalAgent } from "./health.js";

afterEach(() => vi.unstubAllGlobals());

describe("health discovery follows the selected providers", () => {
  it("does not contact an unused agent during an explicit Gemini session", async () => {
    const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ ok: true, providers: { google: true, openai: false } })));
    vi.stubGlobal("fetch", fetcher);
    const agent = shouldProbeLocalAgent({ engine: "google", privacyMode: "default", advanced: {} });
    const result = await probe("https://broker.example", "wss://web.example/agent", "default", { agent });
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["https://broker.example/health"]);
    expect(result.availability).toEqual({ google: true, openai: false, local: false });
  });

  it("retains discovery when auto routing or an explicit local role needs it", () => {
    for (const engine of ["auto", "local"] as const) {
      expect(shouldProbeLocalAgent({ engine, privacyMode: "default", advanced: {} })).toBe(true);
    }
    expect(shouldProbeLocalAgent({ engine: "google", privacyMode: "default", advanced: { evaluation: "local" } })).toBe(true);
    expect(shouldProbeLocalAgent({ engine: "google", privacyMode: "strict_local", advanced: {} })).toBe(true);
  });

  it("still contacts a selected local agent", async () => {
    const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetcher);
    const result = await probe("https://broker.example", "ws://127.0.0.1:8788", "strict_local", { agent: true });
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["http://127.0.0.1:8788/health"]);
    expect(result.availability.local).toBe(true);
  });

  it("never sends strict-local discovery to a remote agent", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await probe("https://broker.example", "wss://agent.example", "strict_local", { agent: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
