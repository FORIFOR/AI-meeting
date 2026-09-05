import { describe, expect, it } from "vitest";
import { ConversationMemory } from "./memory.js";
import type { ChatMessage, LLMAdapter } from "./adapters/llm.js";

class NotesLLM implements LLMAdapter {
  engine = "fake"; model = "fake"; ready = true;
  calls: ChatMessage[][] = [];
  constructor(private readonly notes = "- 相手は週末に京都へ行った（抹茶パフェ）\n- 犬のモモ（柴犬・三歳）", private readonly delayMs = 0) {}
  async *stream() { yield ""; }
  async complete(m: ChatMessage[], opts: { signal?: AbortSignal } = {}) {
    this.calls.push(m);
    if (this.delayMs) await new Promise((r, rej) => { const t = setTimeout(r, this.delayMs); opts.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }); });
    return this.notes;
  }
}

const turn = (i: number): ChatMessage[] => [
  { role: "user", content: `ユーザーの発言${i}。`.padEnd(40, "あ") },
  { role: "assistant", content: `返事${i}。`.padEnd(40, "い") },
];

describe("ConversationMemory", () => {
  it("shows everything verbatim while it fits, and the newest exchange even when it does not", () => {
    const mem = new ConversationMemory({ recentChars: 100 });
    const short = [...turn(1)];
    expect(mem.compose("sys", short).map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    const long: ChatMessage[] = [{ role: "user", content: "x".repeat(300) }, { role: "assistant", content: "y".repeat(300) }, { role: "user", content: "z".repeat(300) }];
    const out = mem.compose("sys", long).slice(1).map((m) => m.content[0]);
    expect(out).toContain("y");
    expect(out).toContain("z");
  });

  it("over budget, stages a cut back to half the budget (not to just-fit) and lands it with the fold", async () => {
    const mem = new ConversationMemory({ recentChars: 170 });
    const history = [...turn(1), ...turn(2), ...turn(3)];
    const out = mem.compose("sys", history);
    expect(out[0]!.content).toBe("sys");
    // Run 90: applied here, the cut cost the turn that crossed the budget a cold prompt (1.6 s) and the
    // fold's notes cost the next one another (2.3 s). Shown verbatim until the fold makes both one change.
    expect(out.slice(1)).toEqual(history);
    expect(mem.dropped).toBe(0);
    expect(mem.pendingChars).toBe(160);
    expect(await mem.fold(new NotesLLM())).toBe(true);
    expect(mem.dropped).toBe(4);
    expect(mem.pendingChars).toBe(0);
    expect(mem.compose("sys", history).slice(1)).toEqual(history.slice(4));
    // The prefix now stays put for the next turns: nothing more is dropped while the half fits.
    mem.compose("sys", [...history, ...turn(4)]);
    expect(mem.dropped).toBe(4);
  });

  it("a compose during the fold, and a failed fold, never hand the same message over twice", async () => {
    const mem = new ConversationMemory({ recentChars: 170 });
    const h3 = [...turn(1), ...turn(2), ...turn(3)];
    mem.compose("sys", h3); // stages turns 1–2
    const llm = new NotesLLM("- メモ", 30);
    const folding = mem.fold(llm);
    const h4 = [...h3, ...turn(4)]; // 320 chars: the hard cap cuts at once, while the fold is running
    mem.compose("sys", h4);
    expect(mem.dropped).toBe(6);
    expect(await folding).toBe(true);
    expect(mem.dropped).toBe(6);
    expect(mem.compose("sys", h4).slice(1)).toEqual(h4.slice(6));
    expect(await mem.fold(llm)).toBe(true);
    const folded = llm.calls.flatMap((c) => c.map((m) => m.content).join("\n"));
    for (const m of h4.slice(0, 6)) expect(folded.filter((f) => f.includes(m.content.slice(0, 8)))).toHaveLength(1);
    expect(mem.pendingChars).toBe(0);

    // A failing fold gives the staged cut back, still shown verbatim, still counted as pending.
    class FailingLLM extends NotesLLM { override async complete(): Promise<string> { throw new Error("down"); } }
    const mem2 = new ConversationMemory({ recentChars: 170 });
    mem2.compose("sys", h3);
    expect(await mem2.fold(new FailingLLM())).toBe(false);
    expect(mem2.dropped).toBe(0);
    expect(mem2.pendingChars).toBe(160);
    expect(await mem2.fold(new NotesLLM())).toBe(true);
    expect(mem2.dropped).toBe(4);
  });

  it("past one and a half budgets the cut is applied at once, folds or no folds", () => {
    const mem = new ConversationMemory({ recentChars: 170 });
    const history = [...turn(1), ...turn(2), ...turn(3), ...turn(4)]; // 320 > 255
    const out = mem.compose("sys", history);
    expect(out.slice(1)).toEqual(history.slice(6));
    expect(mem.dropped).toBe(6);
    expect(mem.pendingChars).toBe(240);
  });

  it("starts the window on a user turn but never drops the character's own last turn", () => {
    const mem = new ConversationMemory({ recentChars: 100 });
    const history: ChatMessage[] = [...turn(1), { role: "assistant", content: "追加の一言。".padEnd(40, "う") }, ...turn(2), { role: "user", content: "いまの発言。" }];
    const out = mem.compose("sys", history).slice(1);
    expect(out[0]!.role).toBe("user");
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[1]!.content.startsWith("返事2")).toBe(true);
  });

  it("folds dropped turns into notes that go in front of the recent turns", async () => {
    const llm = new NotesLLM();
    const mem = new ConversationMemory({ recentChars: 90, foldAfterChars: 100, language: "ja-JP" });
    const history = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
    mem.compose("sys", history);
    expect(await mem.fold(llm)).toBe(true);
    expect(llm.calls).toHaveLength(1);
    // The dropped turns, and only those, were shown to the note-taker.
    const shown = llm.calls[0]!.find((m) => m.role === "user")!.content;
    expect(shown).toContain("ユーザーの発言1");
    expect(shown).not.toContain("ユーザーの発言4");
    const out = mem.compose("sys", history);
    expect(out[0]!.role).toBe("system");
    expect(out[0]!.content.startsWith("sys\n\n【これまでの会話で分かっていること】")).toBe(true);
    expect(out[0]!.content).toContain("京都");
    expect(out[1]!.role).toBe("user");
    expect(mem.pendingChars).toBe(0);
  });

  it("does not fold for a trickle, and never twice at once", async () => {
    const llm = new NotesLLM("- x", 30);
    const mem = new ConversationMemory({ recentChars: 90, foldAfterChars: 100 });
    mem.compose("sys", [...turn(1), ...turn(2)]);
    expect(await mem.fold(llm)).toBe(false); // 40 chars pending < 100
    mem.compose("sys", [...turn(1), ...turn(2), ...turn(3), ...turn(4)]);
    const a = mem.fold(llm);
    const b = mem.fold(llm);
    expect(await b).toBe(false);
    expect(await a).toBe(true);
    expect(llm.calls).toHaveLength(1);
  });

  it("cancelling a fold hands the turns back to pending, nothing is lost", async () => {
    const llm = new NotesLLM("- x", 1000);
    const mem = new ConversationMemory({ recentChars: 90, foldAfterChars: 100 });
    mem.compose("sys", [...turn(1), ...turn(2), ...turn(3), ...turn(4)]);
    const p = mem.fold(llm);
    expect(mem.pendingChars).toBe(0);
    mem.cancelFold();
    expect(await p).toBe(false);
    expect(mem.pendingChars).toBe(240);
    expect(mem.notes).toBe("");
  });

  it("a failed fold keeps the turns too, and a later one includes everything since", async () => {
    let fail = true;
    class FlakyLLM extends NotesLLM {
      override async complete(m: ChatMessage[], opts: { signal?: AbortSignal } = {}) {
        if (fail) { fail = false; throw new Error("503"); }
        return super.complete(m, opts);
      }
    }
    const llm = new FlakyLLM();
    const mem = new ConversationMemory({ recentChars: 90, foldAfterChars: 100 });
    const h = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
    mem.compose("sys", h);
    expect(await mem.fold(llm)).toBe(false);
    expect(mem.pendingChars).toBe(240);
    mem.compose("sys", [...h, ...turn(5)]);
    expect(await mem.fold(llm)).toBe(true);
    expect(llm.calls).toHaveLength(1); // the 503 never reached the recorder
    const shown = llm.calls[0]!.find((m) => m.role === "user")!.content;
    expect(shown).toContain("ユーザーの発言1");
    expect(shown).toContain("ユーザーの発言3");
  });
});
