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
}

/**
 * OpenAI-compatible chat completions (llama.cpp server, Ollama, vLLM, MLX-LM, LM Studio).
 * Only the `/v1/chat/completions` subset is used.
 */
export class OpenAICompatibleLLM implements LLMAdapter {
  readonly engine = "openai-compatible";
  ready = false;
  model: string;

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

  async *stream(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}): AsyncIterable<string> {
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
    const reader = res.body.getReader();
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
  }

  async complete(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      signal: opts.signal,
      body: JSON.stringify({ model: this.model, messages, stream: false, max_tokens: opts.maxTokens ?? 400, temperature: opts.temperature ?? 0.2, ...(opts.json ? { response_format: { type: "json_object" } } : {}), ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}) }),
    });
    if (!res.ok) throw new Error(`llm ${res.status}: ${await res.text().catch(() => "")}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
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
 * The same model, asked twice when it is slow to start.
 *
 * Measured over one afternoon of conversation against gemini-3.5-flash-lite: first-token p50 0.8 s,
 * but 8 turns in 89 took more than 3 s and the worst took 17 s — a person asked a question and heard
 * nothing for seventeen seconds, which in a meeting is the same as no answer (the real-meeting gate
 * closes its window at 15 s). The slow starts are per request, not per model: a second request sent
 * while the first is still silent comes back in the usual time.
 *
 * So: after `afterMs` with no first token, the same request goes out again; the first stream to
 * produce a token is the reply and the other is aborted. A request that fails outright before the
 * deadline is retried the same way. Nothing changes when the first request is prompt, which is the
 * common case. The second request goes to `fallback` when one is given, otherwise to `primary`
 * again — the default, since a different model answers in a different voice.
 */
export class HedgedLLM implements LLMAdapter {
  constructor(
    private readonly primary: LLMAdapter,
    private readonly opts: { afterMs: number; fallback?: LLMAdapter; log?: (line: string) => void; now?: () => number } = { afterMs: 2500 },
  ) {}

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
    const now = this.opts.now ?? Date.now;
    const t0 = now();
    const a = new AbortController();
    const b = new AbortController();
    const onAbort = () => { a.abort(); b.abort(); };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = settle(head(this.primary.stream(messages, { ...opts, signal: a.signal })));
      const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.opts.afterMs); });
      let outcome = await Promise.race([first, deadline]);
      let source: Head | null;
      if (outcome !== "timeout" && outcome.ok) {
        source = outcome.value;
      } else {
        this.opts.log?.(outcome === "timeout" ? `llm hedge: no first token after ${now() - t0}ms, asking again` : `llm hedge: first request failed (${outcome.error.message}), asking again`);
        const second = settle(head((this.opts.fallback ?? this.primary).stream(messages, { ...opts, signal: b.signal })));
        // Whichever answers first. The first request stays in the race: it may still come through
        // before the second one has connected.
        const tagged = { first: first.then((r) => ({ who: "first" as const, r })), second: second.then((r) => ({ who: "second" as const, r })) };
        let winner = outcome === "timeout" ? await Promise.race([tagged.first, tagged.second]) : await tagged.second;
        if (!winner.r.ok && outcome === "timeout") winner = await (winner.who === "first" ? tagged.second : tagged.first); // one failed; wait for the other
        if (!winner.r.ok) throw winner.r.error;
        source = winner.r.value;
        (winner.who === "first" ? b : a).abort();
        this.opts.log?.(`llm hedge: ${winner.who} request answered after ${now() - t0}ms`);
      }
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
      // Aborting the loser is enough for fetch; the other stream's pending promise settles as an
      // error that nobody is waiting for, which `settle` has already made harmless.
    }
  }

  complete(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    return this.primary.complete(messages, opts);
  }
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
