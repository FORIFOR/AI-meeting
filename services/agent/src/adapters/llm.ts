export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMAdapter {
  readonly engine: string;
  readonly model: string;
  readonly ready: boolean;
  /** Streaming token deltas. */
  stream(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): AsyncIterable<string>;
  /** Non-streaming completion (JSON tasks). */
  complete(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal }): Promise<string>;
  /**
   * Put this prompt's prefix into the model's cache before anyone needs it, where the model has one
   * and the call is free. Resolves when the prefix is in; a model without a cache does nothing.
   */
  warm?(messages: ChatMessage[]): Promise<void>;
}

/**
 * OpenAI-compatible chat completions (llama.cpp server, Ollama, vLLM, MLX-LM, LM Studio).
 * Only the `/v1/chat/completions` subset is used.
 */
export class OpenAICompatibleLLM implements LLMAdapter {
  readonly engine = "openai-compatible";
  ready = false;
  model: string;
  private warming: AbortController | null = null;
  private foregroundRequests = 0;

  constructor(
    private readonly baseUrl: string,
    model = "local",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiKey?: string,
    /**
     * How much the model may think before answering, where the endpoint supports it. A thinking model
     * in a conversation is a model that pauses: measured against gemini-3.5-flash, thinking cost
     * ~1.5 s before the first token *and* consumed the whole `max_tokens` budget, so the reply came
     * back as 「私は会議の」 and stopped. "none" is the right setting for talking.
     */
    private readonly reasoningEffort?: string,
  ) {
    this.model = model;
  }

  async init(): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/models`, { headers: this.headers() });
      if (res.ok) {
        const json = (await res.json()) as { data?: { id: string }[] };
        const first = json.data?.[0]?.id;
        if (first && this.model === "local") this.model = first;
        this.ready = true;
      }
    } catch {
      this.ready = false;
    }
  }

  /** llama.cpp on this machine, as opposed to a remote OpenAI-compatible endpoint. */
  private get isLocalServer(): boolean {
    try {
      const h = new URL(this.baseUrl).hostname;
      return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
    } catch {
      return true;
    }
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  /** A cache warm-up must release the local model as soon as someone needs an answer. */
  private beginForeground(): () => void {
    this.foregroundRequests++;
    this.warming?.abort();
    return () => { this.foregroundRequests--; };
  }

  async *stream(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}): AsyncIterable<string> {
    const finish = this.beginForeground();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal: opts.signal,
        /**
         * `cache_prompt` is llama.cpp's, not OpenAI's: it reuses the KV cache for the unchanged system
         * prompt and history prefix, which is most of the local TTFT win. Other servers do not all
         * ignore unknown fields — Gemini's OpenAI-compatible endpoint answers 400 — so it is sent only
         * to a local server, where it is understood.
         */
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          max_tokens: opts.maxTokens ?? 120,
          temperature: opts.temperature ?? 0.7,
          ...(this.isLocalServer ? { cache_prompt: true } : {}),
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
        }),
      });
      if (!res.ok || !res.body) throw new Error(`llm ${res.status}: ${await res.text().catch(() => "")}`);
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            /* ignore keep-alives */
          }
        }
      }
    } finally {
      // A caller can stop consuming at any token. Release that request too: leaving its body open
      // lets the model keep generating an answer nobody will hear while the next turn waits.
      if (reader) {
        try { await reader.cancel(); } catch { /* already aborted or closed */ }
        reader.releaseLock();
      }
      finish();
    }
  }

  async complete(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    const finish = this.beginForeground();
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal: opts.signal,
        body: JSON.stringify({ model: this.model, messages, stream: false, max_tokens: opts.maxTokens ?? 400, temperature: opts.temperature ?? 0.2, ...(opts.json ? { response_format: { type: "json_object" } } : {}), ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}) }),
      });
      if (!res.ok) throw new Error(`llm ${res.status}: ${await res.text().catch(() => "")}`);
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return json.choices?.[0]?.message?.content ?? "";
    } finally {
      finish();
    }
  }

  /**
   * llama.cpp's prompt cache is a prefix cache, and a session's first turn is the one that fills it:
   * measured, a 988-token system prompt costs 3.4 s of prompt evaluation cold and 110 ms warm, and
   * the greeting a character gives on being let into a meeting paid 5.1 s of it (sim 24). One
   * one-token request at session start moves that cost to a moment nobody is waiting. Only the local
   * server: a remote endpoint has no such cache and would be billed for the question.
   */
  async warm(messages: ChatMessage[]): Promise<void> {
    if (!this.isLocalServer || this.foregroundRequests > 0) return;
    this.warming?.abort();
    const controller = new AbortController();
    this.warming = controller;
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal: controller.signal,
        body: JSON.stringify({ model: this.model, messages, stream: false, max_tokens: 1, cache_prompt: true }),
      });
      if (!res.ok) throw new Error(`llm ${res.status}: ${await res.text().catch(() => "")}`);
      await res.arrayBuffer();
    } catch (err) {
      // Superseded warm-ups are best effort, not failures of the conversational model.
      if (!controller.signal.aborted) throw err;
    } finally {
      if (this.warming === controller) this.warming = null;
    }
  }
}

/** Parse an SSE body string (for tests). */
export function parseSse(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((p) => p && p !== "[DONE]");
}

/**
 * The same model, asked again when it is slow to start.
 *
 * Measured over one afternoon of conversation against gemini-3.5-flash-lite: first-token p50 0.8 s,
 * but 8 turns in 89 took more than 3 s and the worst took 17 s — a person asked a question and heard
 * nothing for seventeen seconds, which in a meeting is the same as no answer (the real-meeting gate
 * closes its window at 15 s). The slow starts are per request, not per model: a second request sent
 * while the first is still silent comes back in the usual time.
 *
 * So: after `afterMs` with no first token, the same request goes out again; the first stream to
 * produce a token is the reply and the others are aborted. A request that fails outright is retried
 * the same way. Nothing changes when the first request is prompt, which is the common case. The
 * extra requests go to `fallback` when one is given, otherwise to `primary` again — the default,
 * since a different model answers in a different voice.
 *
 * The ladder has more than one step. Two requests both stalled on the greeting of Gate #8 runs 46
 * and 47 (30.6 s and 22.8 s to the first token: the second request went out at 2.5 s and was as
 * silent as the first), so a third goes out after another `afterMs`; `maxRequests` caps it.
 */
export class HedgedLLM implements LLMAdapter {
  constructor(
    private readonly primary: LLMAdapter,
    private readonly opts: { afterMs: number; maxRequests?: number; fallback?: LLMAdapter; log?: (line: string) => void; now?: () => number } = { afterMs: 2500 },
  ) {}

  /**
   * Until when the ladder is held to one request at a time. A quota error (429 / RESOURCE_EXHAUSTED)
   * is not a slow start: asking again inside the same window spends the quota that is already gone
   * and comes back 429 too. Seen on a 10-minute soak against the free tier (15 requests a minute):
   * three-step hedging on every turn reached the limit at 113 s and three turns were answered with
   * silence — the filler, then nothing. The hold lasts as long as the error asks ("retry in 49s"),
   * 30 s when it does not say.
   */
  private quotaUntil = 0;

  get engine(): string {
    return this.primary.engine;
  }
  get model(): string {
    return this.primary.model;
  }
  get ready(): boolean {
    return this.primary.ready;
  }

  async *stream(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}): AsyncIterable<string> {
    opts.signal?.throwIfAborted();
    const now = this.opts.now ?? Date.now;
    const t0 = now();
    const held = now() < this.quotaUntil;
    const maxRequests = held ? 1 : Math.max(1, this.opts.maxRequests ?? 3);
    if (held) this.opts.log?.(`llm hedge: quota hold, one request only for another ${Math.ceil((this.quotaUntil - now()) / 1000)}s`);
    const controllers: AbortController[] = [];
    const onAbort = () => { for (const c of controllers) c.abort(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // Requests that have neither produced a first token nor failed, in the order they were sent.
    const live: { who: number; p: Promise<{ who: number; r: Settled<Head | null> }> }[] = [];
    const ask = (): void => {
      opts.signal?.throwIfAborted();
      const c = new AbortController();
      controllers.push(c);
      const who = controllers.length;
      const model = who === 1 ? this.primary : (this.opts.fallback ?? this.primary);
      live.push({ who, p: settle(head(model.stream(messages, { ...opts, signal: c.signal }))).then((r) => ({ who, r })) });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let source: Head | null = null;
    try {
      ask();
      let winner = 0;
      for (;;) {
        // Another request may still go out: race the live ones against the clock. At the cap, just wait.
        const deadline = controllers.length < maxRequests
          ? new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.opts.afterMs); })
          : null;
        const outcome = await Promise.race(deadline ? [...live.map((l) => l.p), deadline] : live.map((l) => l.p));
        if (timer) clearTimeout(timer);
        // An interrupted turn must not turn its aborted fetch into the next hedge request.
        opts.signal?.throwIfAborted();
        if (outcome === "timeout") {
          this.opts.log?.(`llm hedge: no first token after ${now() - t0}ms, asking again`);
          ask();
          continue;
        }
        live.splice(live.findIndex((l) => l.who === outcome.who), 1);
        if (outcome.r.ok) {
          source = outcome.r.value;
          winner = outcome.who;
          break;
        }
        if (isQuotaError(outcome.r.error)) {
          const wait = retryAfterMs(outcome.r.error);
          this.quotaUntil = Math.max(this.quotaUntil, now() + wait);
          if (live.length) continue; // the others were sent before the limit was known; one may still land
          this.opts.log?.(`llm hedge: ${ORDINAL[outcome.who - 1] ?? `#${outcome.who}`} request hit the quota, not asking again for ${Math.ceil(wait / 1000)}s`);
          throw outcome.r.error;
        }
        if (live.length) continue; // one failed; the others are still in the race
        if (controllers.length >= maxRequests) throw outcome.r.error;
        this.opts.log?.(`llm hedge: ${ORDINAL[outcome.who - 1] ?? `#${outcome.who}`} request failed (${outcome.r.error.message}), asking again`);
        ask();
      }
      // Whichever answered first is the reply; the rest are cut. (The first request stays in the race
      // after a hedge: it may still come through before the second one has connected.)
      controllers.forEach((c, i) => { if (i + 1 !== winner) c.abort(); });
      if (controllers.length > 1) this.opts.log?.(`llm hedge: ${ORDINAL[winner - 1] ?? `#${winner}`} request answered after ${now() - t0}ms`);
      if (!source) return; // an empty reply, not a slow one
      yield source.first;
      for (;;) {
        const r = await source.rest.next();
        if (r.done) return;
        yield r.value;
      }
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      // Also release the winner when the consumer stops early, before the whole reply is read.
      onAbort();
      await source?.rest.return?.();
      // Losing requests settle as errors that nobody is waiting for; `settle` makes those harmless.
    }
  }

  warm(messages: ChatMessage[]): Promise<void> {
    return this.primary.warm?.(messages) ?? Promise.resolve();
  }

  complete(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    return this.primary.complete(messages, opts);
  }
}

const ORDINAL = ["first", "second", "third", "fourth"];

/** A rate limit or an exhausted quota, as OpenAI-compatible endpoints and Gemini word them. */
export function isQuotaError(err: Error): boolean {
  return /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(err.message);
}

/** How long a quota error asks to be left alone ("Please retry in 49.38s"); 30 s when it does not say, never over a minute. */
export function retryAfterMs(err: Error): number {
  const m = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(err.message);
  return m ? Math.min(60_000, Math.ceil(Number(m[1]) * 1000)) : 30_000;
}

type Head = { first: string; rest: AsyncIterator<string> };
type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

/** The first delta of a stream and the iterator positioned after it; null when the stream is empty. */
async function head(it: AsyncIterable<string>): Promise<Head | null> {
  const rest = it[Symbol.asyncIterator]();
  const r = await rest.next();
  return r.done ? null : { first: r.value, rest };
}

/** A promise that never rejects — a losing request's abort must not surface as an unhandled rejection. */
function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error: error instanceof Error ? error : new Error(String(error)) }));
}
