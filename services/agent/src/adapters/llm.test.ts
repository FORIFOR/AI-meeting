import { describe, expect, it } from "vitest";
import { HedgedLLM, type ChatMessage, type LLMAdapter } from "./llm.js";

/** A model whose first token arrives after `firstAfterMs`, then the rest of `text` at once. */
class SlowStart implements LLMAdapter {
  readonly engine = "fake";
  readonly model = "fake";
  readonly ready = true;
  calls = 0;
  aborted = 0;
  constructor(private readonly text: string, private readonly firstAfterMs: number, private readonly fail = false) {}
  async *stream(_m: ChatMessage[], opts: { signal?: AbortSignal } = {}): AsyncIterable<string> {
    this.calls++;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.firstAfterMs);
      opts.signal?.addEventListener("abort", () => { clearTimeout(t); this.aborted++; reject(new Error("aborted")); }, { once: true });
    });
    if (this.fail) throw new Error("llm 503");
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
  constructor(private readonly plan: { text: string; firstAfterMs: number; fail?: boolean }[]) {}
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

  it("fails only when both requests fail", async () => {
    const llm = new Sequence([{ text: "", firstAfterMs: 10, fail: true }]);
    await expect(collect(new HedgedLLM(llm, { afterMs: 50 }).stream(messages))).rejects.toThrow("llm 503");
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

  it("aborts both requests when the caller aborts", async () => {
    const llm = new Sequence([{ text: "x", firstAfterMs: 2000 }, { text: "y", firstAfterMs: 2000 }]);
    const ac = new AbortController();
    const p = collect(new HedgedLLM(llm, { afterMs: 50 }).stream(messages, { signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 120));
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
    expect(llm.calls).toBe(2);
    expect(llm.aborted).toBe(2);
  });
});
