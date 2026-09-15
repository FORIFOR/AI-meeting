/**
 * Splits a streamed LLM reply into speakable chunks so TTS can start early.
 * - The FIRST chunk of a reply is released at the first clause boundary (、 ，) once it is at
 *   least `firstPhraseMin` chars long (e.g. 「そうですね、」) so audio starts while the LLM
 *   is still generating. Boundaries never fall inside numbers or Latin words (only 、/，/。 etc.).
 *   A comma too early to speak alone (「昨日、」) is skipped for the next one, and there is no
 *   upper bound on that first clause: a reply opening 「昨日、3ページ目の数字について懸念されて
 *   いた点については、」 — 2 chars, then 27 against a cap of 24 — used to be refused at both commas
 *   and wait for the 60-char break, 43 characters of synthesis before the first sound (sim 33:
 *   first audio 2.27 s after the text). The longer clause is always the earlier one.
 * - Later chunks are whole sentences (。！？ / .!? / newline); very long clauses break at 、.
 *   A period waits for following whitespace so a token boundary cannot split a decimal or URL.
 */
export class SentenceChunker {
  private buffer = "";
  private emitted = 0;
  constructor(private readonly maxChars = 60, private readonly firstPhraseMin = 4) {}

  /** Push a delta; returns zero or more speakable chunks. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const end = sentenceBoundary(this.buffer);
      if (end < 0) break;
      const sentence = this.buffer.slice(0, end).trim();
      if (sentence) out.push(sentence);
      this.buffer = this.buffer.slice(end);
    }
    // First phrase of the reply: release at the first clause comma so TTS starts early.
    if (this.emitted === 0 && out.length === 0) {
      const idx = firstClauseBoundary(this.buffer, this.firstPhraseMin);
      if (idx >= 0) {
        out.push(this.buffer.slice(0, idx + 1).trim());
        this.buffer = this.buffer.slice(idx + 1);
      }
    }
    // Long clause without a terminator: break at the last comma to keep latency bounded.
    if (this.buffer.length > this.maxChars) {
      const idx = Math.max(this.buffer.lastIndexOf("、"), this.buffer.lastIndexOf(", "), this.buffer.lastIndexOf("，"));
      if (idx > 10) {
        out.push(this.buffer.slice(0, idx + 1).trim());
        this.buffer = this.buffer.slice(idx + 1);
      }
    }
    this.emitted += out.length;
    return out;
  }

  /** Flush whatever is left. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? rest : null;
  }
}

/** The end of the first complete sentence, retaining punctuation and closing quotation marks. */
function sentenceBoundary(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") return i + 1;
    if (!/[。！？!?.]/.test(ch)) continue;
    let end = i + 1;
    if (ch !== ".") while (end < text.length && /[。！？!?]/.test(text[end]!)) end++;
    while (end < text.length && /[」』）)'"”’]/.test(text[end]!)) end++;
    if (ch === ".") {
      // A delta ending in "3." or "example." is ambiguous until the next token arrives.
      if (end === text.length || !/\s/.test(text[end]!)) continue;
      if (text[i - 1] === "." || text[i + 1] === ".") continue;
      const word = /[A-Za-z.]+$/.exec(text.slice(0, i))?.[0] ?? "";
      if (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|a\.m|p\.m)$/i.test(word)) continue;
      if (/^[A-Z]$/.test(word) || /^(?:[A-Za-z]\.)+[A-Za-z]$/.test(word)) continue;
    }
    return end;
  }
  return -1;
}

/**
 * Index of the first Japanese clause comma (、 or ，) at or after `from` that is not inside
 * digits/Latin text; -1 if none. `from` matters: looking only at the very first comma meant a
 * reply opening 「昨日、」 (too short to speak alone) never got a first phrase at all.
 */
function firstClauseBoundary(text: string, from = 0): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "、" || ch === "，") return i;
    if (ch === ",") {
      const prev = text[i - 1] ?? "";
      const next = text[i + 1] ?? "";
      // "1,000" or "a, b" → not a Japanese clause boundary
      if (/[0-9A-Za-z]/.test(prev) || /[0-9A-Za-z]/.test(next)) continue;
      return i;
    }
  }
  return -1;
}

/** True when a chunk ends a sentence (used for sentence counting in metrics). */
export function endsSentence(chunk: string): boolean {
  return /[。！？!?.][」』）)'"”’]*$/.test(chunk.trim());
}

/** Remove markdown decorations that TTS would read aloud. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}]/gu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ +\n/g, "\n");
}
