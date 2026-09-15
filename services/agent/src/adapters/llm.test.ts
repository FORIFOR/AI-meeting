import { describe, expect, it } from "vitest";
import { HedgedLLM, OpenAICompatibleLLM, type ChatMessage, type LLMAdapter } from "./llm.js";

/** A model whose first token arrives after `firstAfterMs`, then the rest of `text` at once. */
class SlowStart implements LLMAdapter {
  readonly engine = "fake";
  readonly model = "fake";
  readonly ready = true;
  calls = 0;
  aborted = 0;
  constructor(private readonly text: string, private readonly firstAfterMs: number, private readonly fail: boolean | string = false) {}
  async *stream(_m: ChatMessage[], opts: { signal?: AbortSignal } = {}): AsyncIterable<string> {
    this.calls++;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.firstAfterMs);
      opts.signal?.addEventListener("abort", () => { clearTimeout(t); this.aborted++; reject(new Error("aborted")); }, { once: true });
    });
    if (this.fail) throw new Error(typeof this.fail === "string" ? this.fail : "llm 503");
    yield this.text.slice(0, 2);
    yield this.text.slice(2);
  }
  async complete(): Promise<string> {
    return this.text;
  }
}

/** Per-call latencies, so one adapter can be slow on the first request and prompt on the second. */
class Sequence implements LLMAdapter {
  readonly engine = "fake";
  readonly model = "fake";
  readonly ready = true;
  calls = 0;
  aborted = 0;
  constructor(private readonly plan: { text: string; firstAfterMs: number; fail?: boolean | string }[]) {}
  async *stream(m: ChatMessage[], opts: { signal?: AbortSignal } = {}): AsyncIterable<string> {
    const step = this.plan[Math.min(this.calls, this.plan.length - 1)]!;
    this.calls++;
    const inner = new SlowStart(step.text, step.firstAfterMs, step.fail);
    try {
      yield* inner.stream(m, opts);
    } finally {
      this.aborted += inner.aborted;
    }
  }
  async complete(): Promise<string> {
    return "";
  }
}

const collect = async (it: AsyncIterable<string>) => { let s = ""; for await (const d of it) s += d; return s; };
const messages: ChatMessage[] = [{ role: "user", content: "こんにちは" }];

describe("local model foreground priority", () => {
  const completion = () => new Response(JSON.stringify({ choices: [{ message: { content: "はい。" } }] }));
  const delta = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"はい。"}}]}\n\n');

  it.each(["stream", "complete"] as const)("cancels a queued warm-up before %s asks the model for an answer", async (method) => {
    let warmSignal: AbortSignal | undefined;
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { max_tokens: number; stream: boolean };
      if (body.max_tokens === 1) {
        warmSignal = init.signal!;
        return new Promise<Response>((_resolve, reject) => {
          warmSignal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      // On a single-slot local server an outstanding warm-up otherwise queues the real reply.
      expect(warmSignal?.aborted).toBe(true);
      return body.stream ? new Response(delta) : completion();
    }) as typeof fetch;
    const llm = new OpenAICompatibleLLM("http://127.0.0.1:8080/v1", "m", fetchImpl);
    const warm = llm.warm(messages);
    const answer = method === "stream" ? await collect(llm.stream(messages)) : await llm.complete(messages);
    expect(answer).toBe("はい。");
    await warm;
  });

  it("keeps periodic warm-ups out of an active stream and releases an abandoned response", async () => {
    let requests = 0;
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(delta); },
      cancel() { cancelled++; },
    });
    const fetchImpl = (async () => ++requests === 1 ? new Response(body) : completion()) as typeof fetch;
    const llm = new OpenAICompatibleLLM("http://127.0.0.1:8080/v1", "m", fetchImpl);
    const stream = llm.stream(messages)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toBe("はい。");
    await llm.warm(messages);
    expect(requests).toBe(1);
    await stream.return?.();
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
    await llm.warm(messages);
    expect(requests).toBe(2);
  });

  it("does not let a timer warm-up overlap a non-streaming completion", async () => {
    let requests = 0;
    let respond!: (response: Response) => void;
    const fetchImpl = (async () => {
      requests++;
      if (requests === 1) return new Promise<Response>((resolve) => { respond = resolve; });
      return completion();
    }) as typeof fetch;
    const llm = new OpenAICompatibleLLM("http://127.0.0.1:8080/v1", "m", fetchImpl);
    const answer = llm.complete(messages);
    await llm.warm(messages);
    expect(requests).toBe(1);
    respond(completion());
    await answer;
    await llm.warm(messages);
    expect(requests).toBe(2);
  });

  it("replaces obsolete warm-ups and still warms again after a failed foreground request", async () => {
    const warmSignals: AbortSignal[] = [];
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      if ((JSON.parse(init.body as string) as { max_tokens: number }).max_tokens !== 1) throw new Error("model unavailable");
      warmSignals.push(init.signal!);
      if (warmSignals.length === 3) return completion();
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as typeof fetch;
    const llm = new OpenAICompatibleLLM("http://127.0.0.1:8080/v1", "m", fetchImpl);
    const first = llm.warm(messages);
    const second = llm.warm([{ role: "system", content: "Updated persona" }]);
    expect(warmSignals[0]!.aborted).toBe(true);
    await expect(collect(llm.stream(messages))).rejects.toThrow("model unavailable");
    expect(warmSignals[1]!.aborted).toBe(true);
    await Promise.all([first, second]);
    await llm.warm(messages);
    expect(warmSignals).toHaveLength(3);
    expect(warmSignals[2]!.aborted).toBe(false);
  });
});

describe("HedgedLLM", () => {
  it("leaves a prompt first request alone", async () => {
    const llm = new Sequence([{ text: "はい、聞こえてるよ。", firstAfterMs: 10 }]);
    const lines: string[] = [];
    const out = await collect(new HedgedLLM(llm, { afterMs: 200, log: (l) => lines.push(l) }).stream(messages));
    expect(out).toBe("はい、聞こえてるよ。");
    expect(llm.calls).toBe(1);
    expect(lines).toEqual([]);
  });

  it("asks again when the first token is late, and speaks whichever answers first", async () => {
    const llm = new Sequence([{ text: "遅い方", firstAfterMs: 2000 }, { text: "早い方", firstAfterMs: 20 }]);
    const lines: string[] = [];
    const t0 = Date.now();
    const out = await collect(new HedgedLLM(llm, { afterMs: 100, log: (l) => lines.push(l) }).stream(messages));
    expect(out).toBe("早い方");
    expect(llm.calls).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1000); // did not wait for the slow one
    expect(llm.aborted).toBe(1); // the slow one was cut
    expect(lines[0]).toMatch(/no first token after/);
    expect(lines[1]).toMatch(/second request answered/);
  });

  it("keeps the first request in the race after hedging", async () => {
    const llm = new Sequence([{ text: "一つ目", firstAfterMs: 150 }, { text: "二つ目", firstAfterMs: 2000 }]);
    const out = await collect(new HedgedLLM(llm, { afterMs: 100 }).stream(messages));
    expect(out).toBe("一つ目");
    expect(llm.aborted).toBe(1);
  });

  it("retries at once when the first request fails before the deadline", async () => {
    const llm = new Sequence([{ text: "", firstAfterMs: 10, fail: true }, { text: "二度目で成功", firstAfterMs: 10 }]);
    const out = await collect(new HedgedLLM(llm, { afterMs: 5000 }).stream(messages));
    expect(out).toBe("二度目で成功");
    expect(llm.calls).toBe(2);
  });

  it("fails only when every request on the ladder fails", async () => {
    const llm = new Sequence([{ text: "", firstAfterMs: 10, fail: true }]);
    await expect(collect(new HedgedLLM(llm, { afterMs: 50 }).stream(messages))).rejects.toThrow("llm 503");
    expect(llm.calls).toBe(3);
  });

  it("asks a third time when the second request is as silent as the first (Gate #8 runs 46/47: both stalled 20–30 s)", async () => {
    const llm = new Sequence([{ text: "一つ目", firstAfterMs: 5000 }, { text: "二つ目", firstAfterMs: 5000 }, { text: "三つ目", firstAfterMs: 20 }]);
    const lines: string[] = [];
    const t0 = Date.now();
    const out = await collect(new HedgedLLM(llm, { afterMs: 100, log: (l) => lines.push(l) }).stream(messages));
    expect(out).toBe("三つ目");
    expect(llm.calls).toBe(3);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(llm.aborted).toBe(2);
    expect(lines.filter((l) => /no first token/.test(l))).toHaveLength(2);
    expect(lines.at(-1)).toMatch(/third request answered/);
  });

  it("stops at maxRequests and waits for what it has", async () => {
    const llm = new Sequence([{ text: "一つ目", firstAfterMs: 400 }, { text: "二つ目", firstAfterMs: 5000 }]);
    const out = await collect(new HedgedLLM(llm, { afterMs: 100, maxRequests: 2 }).stream(messages));
    expect(out).toBe("一つ目");
    expect(llm.calls).toBe(2);
  });

  it("does not ask again after a quota error, and holds the ladder to one request for as long as it asked", async () => {
    const quota = 'llm 429: [{"code":429,"message":"You exceeded your current quota. Please retry in 0.2s.","status":"RESOURCE_EXHAUSTED"}]';
    const llm = new Sequence([{ text: "", firstAfterMs: 10, fail: quota }, { text: "遅いけど答えるよ。", firstAfterMs: 120 }]);
    const lines: string[] = [];
    const hedged = new HedgedLLM(llm, { afterMs: 50, log: (l) => lines.push(l) });
    await expect(collect(hedged.stream(messages))).rejects.toThrow(/429/);
    expect(llm.calls).toBe(1); // a retry inside the window would be the same 429, at the price of a request
    expect(lines).toEqual(["llm hedge: first request hit the quota, not asking again for 1s"]);
    // The next turn, inside the window: the first token is late but the ladder stays on one request.
    const out = await collect(hedged.stream(messages));
    expect(out).toBe("遅いけど答えるよ。");
    expect(llm.calls).toBe(2);
    expect(lines[1]).toMatch(/quota hold, one request only/);
    // After the window it hedges again.
    await new Promise((r) => setTimeout(r, 120));
    await collect(hedged.stream(messages));
    expect(llm.calls).toBe(5); // 120 ms to the first token at afterMs 50: the full three-step ladder again
  });

  it("a quota error on one request does not give up on the others already in flight", async () => {
    const quota = "llm 429: RESOURCE_EXHAUSTED";
    const llm = new Sequence([{ text: "", firstAfterMs: 80, fail: quota }, { text: "こっちは間に合った。", firstAfterMs: 60 }]);
    const out = await collect(new HedgedLLM(llm, { afterMs: 50 }).stream(messages));
    expect(out).toBe("こっちは間に合った。");
    expect(llm.calls).toBe(2);
  });

  it("uses the fallback model for the second request when given one", async () => {
    const slow = new Sequence([{ text: "本命", firstAfterMs: 2000 }]);
    const fallback = new Sequence([{ text: "控え", firstAfterMs: 10 }]);
    const out = await collect(new HedgedLLM(slow, { afterMs: 50, fallback }).stream(messages));
    expect(out).toBe("控え");
    expect(fallback.calls).toBe(1);
    expect(slow.aborted).toBe(1);
  });

  it("aborts every request when the caller aborts", async () => {
    const llm = new Sequence([{ text: "x", firstAfterMs: 2000 }, { text: "y", firstAfterMs: 2000 }]);
    const ac = new AbortController();
    const p = collect(new HedgedLLM(llm, { afterMs: 50 }).stream(messages, { signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 130));
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
    expect(llm.calls).toBe(3); // 0 ms, 50 ms, 100 ms
    expect(llm.aborted).toBe(3);
  });

  it("does not start a request for a turn that was already cancelled", async () => {
    const llm = new Sequence([{ text: "x", firstAfterMs: 10 }]);
    const ac = new AbortController();
    ac.abort(new Error("aborted"));
    await expect(collect(new HedgedLLM(llm).stream(messages, { signal: ac.signal }))).rejects.toThrow("aborted");
    expect(llm.calls).toBe(0);
  });

  it("does not retry when interrupted before the first hedge deadline", async () => {
    const llm = new Sequence([{ text: "x", firstAfterMs: 2000 }]);
    const ac = new AbortController();
    const answer = collect(new HedgedLLM(llm, { afterMs: 1000 }).stream(messages, { signal: ac.signal }));
    ac.abort(new Error("aborted"));
    await expect(answer).rejects.toThrow("aborted");
    expect(llm.calls).toBe(1);
    expect(llm.aborted).toBe(1);
  });

  it("closes the winning stream when playback no longer needs its reply", async () => {
    let signal: AbortSignal | undefined;
    let closed = false;
    const llm: LLMAdapter = {
      engine: "fake", model: "fake", ready: true,
      async complete() { return ""; },
      async *stream(_messages, opts) {
        signal = opts.signal;
        try { yield "はい。"; yield "続き。"; } finally { closed = true; }
      },
    };
    const stream = new HedgedLLM(llm).stream(messages)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toBe("はい。");
    await stream.return?.();
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(true);
  });
});
