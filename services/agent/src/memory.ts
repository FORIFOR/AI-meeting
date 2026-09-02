import type { ChatMessage, LLMAdapter } from "./adapters/llm.js";

export interface ConversationMemoryOptions {
  /** Characters of the most recent turns the model sees verbatim. */
  recentChars: number;
  /** Fold dropped turns into the notes once this many characters have left the window. Default 1. */
  foldAfterChars?: number;
  /** Upper bound on the notes themselves. Default 800. */
  maxNotesChars?: number;
  language?: string;
}

/**
 * What the character remembers of a conversation once it no longer fits in front of the model.
 *
 * A fixed window of the last twelve messages is six exchanges: about two minutes of talk. Measured on a
 * twenty-turn chat, the character answered 「私が週末どこに行ったか覚えてる？」 with 「ごめん！どこ行ったんだっけ？」
 * five minutes after being told, which is not a friend, it is a form. So the window is a character
 * budget instead — a few thousand characters, more for a cloud model — and what falls out of it is
 * folded into running notes by the same model, in the background, between turns. The notes go in
 * front of the recent turns as a second system message, so 京都 and モモ survive the whole session.
 *
 * Folding never sits in the reply path: it starts once a reply's tokens have all arrived (the model is
 * idle while the voice speaks) and is cancelled the moment a new user turn needs the model. A cancelled
 * or failed fold keeps its turns pending for the next chance.
 */
export class ConversationMemory {
  notes = "";
  private cursor = 0;
  private pending: ChatMessage[] = [];
  private folding: AbortController | null = null;
  private readonly foldAfterChars: number;
  private readonly maxNotesChars: number;

  constructor(private readonly opts: ConversationMemoryOptions) {
    this.foldAfterChars = opts.foldAfterChars ?? 1;
    this.maxNotesChars = opts.maxNotesChars ?? 800;
  }

  reset(): void {
    this.cancelFold();
    this.notes = "";
    this.cursor = 0;
    this.pending = [];
  }

  /** Characters waiting to be folded into the notes. */
  get pendingChars(): number {
    return this.pending.reduce((n, m) => n + m.content.length, 0);
  }

  /** How many of `history`'s oldest messages are no longer shown verbatim. */
  get dropped(): number {
    return this.cursor;
  }

  /**
   * The messages for the next model call: system prompt, notes (if any), then the recent turns that
   * fit the budget. Advances the window; whatever it pushes out becomes pending for the next fold.
   */
  compose(systemPrompt: string, history: ChatMessage[]): ChatMessage[] {
    let chars = 0;
    for (let i = this.cursor; i < history.length; i++) chars += history[i]!.content.length;
    if (chars > this.opts.recentChars) {
      /**
       * Over budget: cut back to half, not to just-fit. A window that slides one message per turn
       * changes the prompt's prefix every turn, and llama.cpp's prompt cache is a prefix cache —
       * measured on the local model, first-token went from 130 ms to 1.2 s the moment sliding
       * began. Cutting in halves means one cold prompt per half-window (a dozen turns locally),
       * and the fold that follows changes the notes at the same moment, so the two misses are one.
       */
      let keep = 0;
      let start = history.length;
      while (start > this.cursor) {
        const len = history[start - 1]!.content.length;
        if (keep + len > this.opts.recentChars / 2 && history.length - start >= 2) break;
        keep += len;
        start--;
      }
      // Start the window on the user's side of an exchange (stepping back, so nothing kept is lost).
      while (start > this.cursor && history[start]!.role !== "user") start--;
      this.pending.push(...history.slice(this.cursor, start));
      this.cursor = start;
    }
    // One system message, notes last. As a second system message the notes changed the character:
    // replies went from two sentences to five, the register slipped (「君」), and it recalled things the
    // notes never said (「あの写真を見せてもらった時」). Appended under the persona with a one-line
    // caveat, they read as what they are — something the character happens to know.
    const system = this.notes ? `${systemPrompt}\n\n${this.heading()}\n${this.notes}\n${this.caveat()}` : systemPrompt;
    return [{ role: "system", content: system }, ...history.slice(this.cursor)];
  }

  /**
   * Fold pending turns into the notes with one non-streaming completion. Resolves `false` when there was
   * nothing to do, a fold was already running, or the fold was cancelled/failed (the turns stay pending).
   */
  async fold(llm: LLMAdapter, log?: (msg: string) => void): Promise<boolean> {
    if (this.folding || this.pendingChars < this.foldAfterChars) return false;
    const batch = this.pending;
    this.pending = [];
    const ac = new AbortController();
    this.folding = ac;
    const t0 = Date.now();
    try {
      const text = await llm.complete(this.foldPrompt(batch), { maxTokens: 400, temperature: 0.2, signal: ac.signal });
      const next = text.trim();
      if (!next) throw new Error("empty notes");
      this.notes = next.length > this.maxNotesChars ? next.slice(0, this.maxNotesChars) : next;
      log?.(`memory folded ${batch.length} msgs in ${Date.now() - t0}ms → ${this.notes.length} chars of notes:\n${this.notes}`);
      return true;
    } catch (err) {
      this.pending = [...batch, ...this.pending];
      if (!ac.signal.aborted) log?.(`memory fold failed: ${(err as Error).message}`);
      return false;
    } finally {
      if (this.folding === ac) this.folding = null;
    }
  }

  /** Give the model back to the conversation; the batch returns to pending. */
  cancelFold(): void {
    this.folding?.abort();
  }

  private get ja(): boolean {
    return (this.opts.language ?? "ja").toLowerCase().startsWith("ja");
  }

  private heading(): string {
    return this.ja ? "【これまでの会話で分かっていること】" : "[What you know from earlier in this conversation]";
  }

  private caveat(): string {
    return this.ja
      ? "（メモは自分の記憶。話題に出たときだけ自然に使い、読み上げたり一度に全部触れたりしない。メモにないことは覚えていない。話し方や長さはこれまで通り。）"
      : "(These notes are your own memory. Use them only when relevant, never recite them or bring them all up at once. What is not in them, you do not remember. Your manner and reply length are unchanged.)";
  }

  private foldPrompt(batch: ChatMessage[]): ChatMessage[] {
    const you = this.ja ? "相手" : "Them";
    const me = this.ja ? "自分" : "You";
    const lines = batch.map((m) => `${m.role === "user" ? you : me}: ${m.content}`).join("\n");
    if (this.ja) {
      return [
        { role: "system", content: "あなたは会話の記憶係です。箇条書きのメモだけを出力します。" },
        {
          role: "user",
          content:
            `これまでのメモ:\n${this.notes || "（なし）"}\n\n新しく流れた会話:\n${lines}\n\n` +
            "メモを更新してください。相手について分かったこと（名前・人物・出来事・予定・数字・好み・気持ち）と、自分が話したこと・約束したことを、固有名詞をそのまま残して箇条書きにします。" +
            "古い項目も残し、重複はまとめ、全体で12行以内。箇条書き以外は書かないでください。",
        },
      ];
    }
    return [
      { role: "system", content: "You keep the notes for a conversation. Output only a bullet list." },
      {
        role: "user",
        content:
          `Notes so far:\n${this.notes || "(none)"}\n\nConversation that just scrolled out of view:\n${lines}\n\n` +
          "Update the notes: what you learned about them (names, people, events, plans, numbers, likes, feelings) and what you said or promised. " +
          "Keep proper nouns verbatim, keep old items, merge duplicates, at most 12 lines. Bullets only.",
      },
    ];
  }
}
