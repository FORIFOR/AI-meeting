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

  constructor(private readonly baseUrl: string, model = "local", private readonly fetchImpl: typeof fetch = fetch, private readonly apiKey?: string) {
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

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async *stream(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}): AsyncIterable<string> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      signal: opts.signal,
      // cache_prompt: llama.cpp reuses the KV cache for the unchanged system prompt + history prefix (TTFT ↓); other servers ignore it.
      body: JSON.stringify({ model: this.model, messages, stream: true, max_tokens: opts.maxTokens ?? 120, temperature: opts.temperature ?? 0.7, cache_prompt: true }),
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
      body: JSON.stringify({ model: this.model, messages, stream: false, max_tokens: opts.maxTokens ?? 400, temperature: opts.temperature ?? 0.2, ...(opts.json ? { response_format: { type: "json_object" } } : {}) }),
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
