import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@rcai/conversation-core";
import type { EvaluationInput } from "@rcai/provider-core";
import { sessionRecordToEvaluationInput, resolveProfile } from "./record.js";
import { HeuristicEvaluator, evaluateHeuristically, englishDeferredNotes, tokens, isJapanese} from "./heuristic.js";
import { buildEvaluationPrompt, parseEvaluationResult, EvaluationParseError, EVALUATION_JSON_SCHEMA } from "./prompt.js";
import { evaluateWithOpenAICompatible, evaluateWithGemini, EvaluationError } from "./llm.js";
import { EvaluationSidecar } from "./sidecar.js";

const Q1 = "自己紹介をお願いします。これまでのご経験を教えてください。";
const Q2 = "なぜ弊社を志望されたのですか？";

function input(userAnswers: [string, string], extra: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    mode: "interview",
    language: "ja-JP",
    evaluationProfile: "interview_standard",
    transcript: [
      { role: "assistant", text: Q1 },
      { role: "user", text: userAnswers[0] },
      { role: "assistant", text: Q2 },
      { role: "user", text: userAnswers[1] },
    ],
    timing: { responseLatenciesMs: [600, 700], userSilencesMs: [900, 1100], userSpeechDurationsMs: [12000, 9000], assistantSpeechDurationsMs: [3000, 2500] },
    interruptions: { byUser: 0, byAssistant: 0 },
    ...extra,
  };
}

const GOOD: [string, string] = [
  "結論から言うと、私は5年間バックエンドエンジニアとして経験を積んできました。理由は、大学時代からサーバー開発に興味があったからです。具体的には、前職では決済システムの担当として3人のチームを率い、処理時間を40%短縮しました。",
  "御社を志望した理由は、決済領域で自分の経験を活かせると考えたからです。例えば、御社のプロダクトは月間100万件の取引を扱っており、私の高負荷システムの経験が貢献できると思います。",
];
const RAMBLING: [string, string] = [
  "えーっと、あのー、まあ、なんか、いろいろやってきたというか、たぶんエンジニアみたいな感じで、あの、うーん、そうですね、なんかいろいろです。",
  "えー、たぶん、なんとなく、いいかなと思って、あの、まあ、なんか。",
];

describe("sessionRecordToEvaluationInput", () => {
  it("maps record fields and never carries audio", () => {
    const record: SessionRecord = {
      sessionId: "s1", providerId: "local", mode: "english_lesson", characterId: "yui", personaId: "english_free_talk", language: "en-US",
      startedAt: 0, endedAt: 100,
      turns: [{ role: "assistant", text: "Hi", startedAt: 0, endedAt: 1 }, { role: "user", text: "Hello", startedAt: 2, endedAt: 3, interrupted: false }, { role: "assistant", text: "Nice", startedAt: 4, endedAt: 5, interrupted: true }],
      timing: { responseLatenciesMs: [500], userSilencesMs: [800], userSpeechDurationsMs: [1000], assistantSpeechDurationsMs: [900] },
      interruptions: { byUser: 1, byAssistant: 0 },
      audioMetrics: { frames: 10, userLevelDb: -30 },
      metadata: { level: "beginner" },
    };
    const inp = sessionRecordToEvaluationInput(record, { lesson: "travel" });
    expect(inp.mode).toBe("english_lesson");
    expect(inp.evaluationProfile).toBe("english_conversation");
    expect(inp.transcript).toEqual([{ role: "assistant", text: "Hi" }, { role: "user", text: "Hello" }, { role: "assistant", text: "Nice", interrupted: true }]);
    expect(inp.timing.userSilencesMs).toEqual([800]);
    expect(inp.interruptions.byUser).toBe(1);
    expect(inp.audioMetrics).toEqual({ userLevelDb: -30 });
    expect(inp.params).toEqual({ level: "beginner", lesson: "travel" });
    expect(JSON.stringify(inp)).not.toContain("frames");
    expect(resolveProfile({ mode: "sales_roleplay" })).toBe("sales_roleplay");
    expect(resolveProfile({ mode: "free_talk", evaluationProfile: "bogus" })).toBe("free_talk");
  });
});

describe("HeuristicEvaluator", () => {
  it("scores a structured answer above a rambling one on every dimension", async () => {
    const ev = new HeuristicEvaluator();
    expect(ev.id).toBe("local");
    const good = await ev.evaluate(input(GOOD));
    const bad = await ev.evaluate(input(RAMBLING, { timing: { responseLatenciesMs: [600, 700], userSilencesMs: [4500, 5200], userSpeechDurationsMs: [12000, 9000], assistantSpeechDurationsMs: [3000, 2500] } }));
    for (const k of ["overall", "clarity", "specificity", "structure", "relevance", "fluency"] as const) {
      expect(good[k]).toBeGreaterThan(bad[k]);
      expect(good[k]).toBeGreaterThanOrEqual(0);
      expect(good[k]).toBeLessThanOrEqual(100);
    }
    expect(good.overall).toBeGreaterThanOrEqual(70);
    expect(bad.overall).toBeLessThan(60);
    expect(good.feedback.length).toBeGreaterThan(0);
    expect(bad.feedback.length).toBeGreaterThan(1);
    expect(bad.feedback.some((f) => /つなぎ言葉/.test(f))).toBe(true);
    expect(bad.feedback.some((f) => /間が平均/.test(f))).toBe(true);
    expect(good.improvedAnswer.length).toBeGreaterThan(20);
    expect(good.improvedAnswer).toContain("結論");
    expect(bad.improvedAnswer).not.toMatch(/えーっと|あのー/);
    expect(good.evaluatedBy).toBe("local:heuristic");
  });
  it("handles English conversation profile with deferred notes and language mixing", () => {
    const r = evaluateHeuristically({
      mode: "english_lesson", language: "en-US",
      transcript: [
        { role: "assistant", text: "What did you do last weekend?" },
        { role: "user", text: "i goed to Kyoto and eated a apple. It was very very good. 京都 is nice." },
        { role: "assistant", text: "Nice! What was the best part?" },
        { role: "user", text: "The best part was the temple, because it was quiet." },
      ],
      timing: { responseLatenciesMs: [500], userSilencesMs: [1000, 1200], userSpeechDurationsMs: [5000, 4000], assistantSpeechDurationsMs: [2000, 2000] },
      interruptions: { byUser: 0, byAssistant: 0 },
    });
    expect(r.feedback.some((f) => /Capitalize "I"/.test(f))).toBe(true);
    expect(r.feedback.some((f) => /irregular past/.test(f))).toBe(true);
    expect(r.feedback.some((f) => /Japanese words slipped/.test(f))).toBe(true);
    expect(r.feedback.every((f) => !/[぀-ヿ一-鿿]/.test(f) || /Japanese/.test(f))).toBe(true);
    expect(r.improvedAnswer).toMatch(/^In short,/);
    expect(englishDeferredNotes("I ate an apple.")).toEqual([]);
  });
  it("returns zeros with an explanatory note when there is no user speech", () => {
    const r = evaluateHeuristically({ mode: "free_talk", language: "ja-JP", transcript: [{ role: "assistant", text: "こんにちは" }], timing: { responseLatenciesMs: [], userSilencesMs: [], userSpeechDurationsMs: [], assistantSpeechDurationsMs: [] }, interruptions: { byUser: 0, byAssistant: 0 } });
    expect(r.overall).toBe(0);
    expect(r.feedback[0]).toMatch(/評価できる発話/);
    expect(tokens("面接の経験を教えてください", true)).toContain("面接");
  });
});

describe("prompt + parser", () => {
  it("builds a Japanese prompt with rubric, schema and transcript", () => {
    const p = buildEvaluationPrompt(input(GOOD, { params: { position: "Backend" } }));
    expect(p.system).toContain("面接練習");
    expect(p.system).toContain(JSON.stringify(EVALUATION_JSON_SCHEMA));
    expect(p.user).toContain("USER:");
    expect(p.user).toContain("params=");
    const e = buildEvaluationPrompt({ ...input(GOOD), language: "en-US", mode: "english_lesson", evaluationProfile: "english_conversation", transcript: [{ role: "user", text: "hello there" }] });
    expect(e.system).toContain("English conversation practice");
  });
  it("parses fenced / noisy JSON, clamps and fills fields", () => {
    const r = parseEvaluationResult('Sure! ```json\n{"overall": 140, "clarity": "77", "feedback": "one note", "improved_answer": "x"}\n```', "t");
    expect(r.overall).toBe(100);
    expect(r.clarity).toBe(77);
    expect(r.specificity).toBe(50);
    expect(r.feedback).toEqual(["one note"]);
    expect(r.improvedAnswer).toBe("x");
    expect(r.evaluatedBy).toBe("t");
    const mean = parseEvaluationResult('{"clarity":80,"specificity":60,"structure":70,"relevance":90,"fluency":50,"feedback":[],"improvedAnswer":""}');
    expect(mean.overall).toBe(70);
    expect(() => parseEvaluationResult("not json at all")).toThrow(EvaluationParseError);
  });
});

describe("LLM evaluators", () => {
  const good = { overall: 82, clarity: 88, specificity: 74, structure: 85, relevance: 90, fluency: 81, feedback: ["ok"], improvedAnswer: "better" };
  it("evaluateWithOpenAICompatible sends JSON mode and parses the completion", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await evaluateWithOpenAICompatible({ baseUrl: "http://127.0.0.1:8080/v1/", model: "gemma", fetch: fetchMock }, input(GOOD));
    expect(r.overall).toBe(82);
    expect(r.evaluatedBy).toBe("openai-compatible:gemma");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(calls[0]!.body.response_format).toEqual({ type: "json_object" });
    expect((calls[0]!.body.messages as { role: string }[])[0]!.role).toBe("system");
  });
  it("retries without response_format on 400 and throws typed errors otherwise", async () => {
    let n = 0;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      n++;
      const body = JSON.parse(String(init.body));
      if (body.response_format) return new Response("bad", { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(good) + "\n```" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await evaluateWithOpenAICompatible({ baseUrl: "http://x/v1", model: "m", fetch: fetchMock }, input(GOOD));
    expect(n).toBe(2);
    expect(r.relevance).toBe(90);
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(evaluateWithOpenAICompatible({ baseUrl: "http://x/v1", model: "m", fetch: failing }, input(GOOD))).rejects.toMatchObject({ name: "EvaluationError", kind: "http", status: 500 });
    const empty = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(evaluateWithOpenAICompatible({ baseUrl: "http://x/v1", model: "m", fetch: empty }, input(GOOD))).rejects.toBeInstanceOf(EvaluationError);
    await expect(evaluateWithOpenAICompatible({ baseUrl: "", model: "m" }, input(GOOD))).rejects.toMatchObject({ kind: "config" });
  });
  it("evaluateWithGemini uses structured output fields and the api-key header", async () => {
    let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const fetchMock = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(good) }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await evaluateWithGemini({ apiKey: "k", model: "gemini-2.5-flash", fetch: fetchMock }, input(GOOD));
    expect(r.overall).toBe(82);
    expect(seen!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(seen!.headers["x-goog-api-key"]).toBe("k");
    const gc = seen!.body.generationConfig as Record<string, unknown>;
    expect(gc.responseMimeType).toBe("application/json");
    expect((gc.responseSchema as { type: string }).type).toBe("OBJECT");
    expect(seen!.body.systemInstruction).toBeDefined();
    await expect(evaluateWithGemini({ apiKey: "", model: "g" }, input(GOOD))).rejects.toMatchObject({ kind: "config", message: "BLOCKED_BY_GEMINI_KEY" });
  });
});

describe("EvaluationSidecar", () => {
  it("fires interval feedback every 4 user turns without blocking, and evaluates at the end", async () => {
    const record: SessionRecord = { sessionId: "s", providerId: "local", mode: "english_lesson", language: "en-US", startedAt: 0, turns: [], timing: { responseLatenciesMs: [], userSilencesMs: [], userSpeechDurationsMs: [], assistantSpeechDurationsMs: [] }, interruptions: { byUser: 0, byAssistant: 0 }, audioMetrics: { frames: 0 } };
    let evalCalls = 0;
    const provider = { id: "local" as const, evaluate: async () => { evalCalls++; await new Promise((r) => setTimeout(r, 5)); return { overall: 70, clarity: 70, specificity: 70, structure: 70, relevance: 70, fluency: 70, feedback: ["f"], improvedAnswer: "" }; } };
    const sc = new EvaluationSidecar({ getRecord: () => record, provider });
    const fired: number[] = [];
    sc.onInterval(4, (_r, turns) => fired.push(turns));
    for (let i = 1; i <= 9; i++) {
      record.turns.push({ role: "user", text: `turn ${i}`, startedAt: i, endedAt: i });
      sc.handleEvent({ type: "user_transcript", text: `turn ${i}`, final: true });
      sc.handleEvent({ type: "user_transcript", text: "partial", final: false });
    }
    expect(fired).toEqual([]); // async: nothing yet
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toEqual([4, 8]);
    expect(sc.userTurns).toBe(9);
    const final = await sc.evaluateFinal();
    expect(final?.overall).toBe(70);
    expect(evalCalls).toBe(3);
    const errors: unknown[] = [];
    const broken = new EvaluationSidecar({ getRecord: () => record, provider: { id: "local", evaluate: async () => { throw new Error("boom"); } }, onError: (e) => errors.push(e) });
    expect(await broken.evaluateFinal()).toBeNull();
    expect(errors.length).toBe(1);
    sc.handleEvent({ type: "session_closed" });
    sc.handleEvent({ type: "user_transcript", text: "late" });
    expect(sc.userTurns).toBe(9);
  });
});

import { isEvidenceEvaluation, validateEvidence } from "./evidence.js";
import { questionBreakdown, speechMetrics } from "./evidenceHeuristic.js";

const ABSTRACT: [string, string] = [
  "困難はありました。なんとかチームで解決しました。",
  "当時、納品が2週間遅れていました。私はタスクを分解して優先順位を決め、毎朝15分の進捗確認を提案しました。その結果、納期を守れて、顧客からの評価も上がりました。",
];

describe("evidence-based evaluation", () => {
  it("heuristic result carries criteria with verbatim quotes, speech metrics and per-question breakdown", () => {
    const r = evaluateHeuristically(input(ABSTRACT));
    expect(isEvidenceEvaluation(r)).toBe(true);
    expect(r.criteria.map((c) => c.key)).toEqual(["relevance", "specificity", "star_structure", "logical_clarity", "conciseness", "confidence"]);
    const spec = r.criteria.find((c) => c.key === "specificity")!;
    expect(spec.evidence.length).toBeGreaterThan(0);
    for (const c of r.criteria) for (const e of c.evidence) {
      const turn = input(ABSTRACT).transcript[e.turnIndex]!;
      expect(turn.role).toBe("user");
      expect(turn.text.includes(e.quote)).toBe(true);
    }
    expect(spec.evidence[0]!.quote).toContain("なんとかチームで解決しました");
    expect(spec.improvement).toContain("具体的な数値");
    expect(r.speech.fillerCount).toBe(0);
    expect(r.speech.paceCharsPerSec).toBeGreaterThan(0);
    expect(r.questions!.length).toBe(2);
    const q1 = r.questions![0]!;
    expect(q1.issues).toContain("結果の説明が抽象的");
    const q2 = r.questions![1]!;
    expect(q2.star).toEqual({ situation: true, task: true, action: true, result: true });
    expect(q2.specificity).toBeGreaterThan(q1.specificity);
  });
  it("orders good vs rambling on evidence criteria too and STAR detection distinguishes them", () => {
    const good = evaluateHeuristically(input(GOOD));
    const bad = evaluateHeuristically(input(RAMBLING));
    const score = (r: ReturnType<typeof evaluateHeuristically>, k: string) => r.criteria.find((c) => c.key === k)!.score;
    for (const k of ["specificity", "confidence", "logical_clarity", "relevance"]) expect(score(good, k)).toBeGreaterThan(score(bad, k));
    expect(score(good, "star_structure")).toBeGreaterThan(score(bad, "star_structure"));
    expect(bad.criteria.find((c) => c.key === "confidence")!.evidence[0]!.quote).toMatch(/たぶん|なんとなく/);
    expect(bad.speech.fillerCount).toBeGreaterThan(5);
  });
  it("english profile yields grammar/vocabulary/naturalness with a clearly labelled pronunciation proxy", () => {
    const en: EvaluationInput = {
      mode: "english_lesson", language: "en-US", evaluationProfile: "english_conversation",
      transcript: [
        { role: "assistant", text: "What did you do last weekend?" },
        { role: "user", text: "Um, i goed to a park with my 友達 and it was very very fun. She go there every week." },
      ],
      timing: { responseLatenciesMs: [500], userSilencesMs: [800], userSpeechDurationsMs: [7000], assistantSpeechDurationsMs: [2000] },
      interruptions: { byUser: 0, byAssistant: 0 },
    };
    const r = evaluateHeuristically(en);
    expect(r.criteria.map((c) => c.key)).toEqual(["fluency", "grammar", "vocabulary", "naturalness", "pronunciation_proxy"]);
    const g = r.criteria.find((c) => c.key === "grammar")!;
    expect(g.explanation).toMatch(/irregular past/);
    expect(g.evidence.some((e) => e.quote.includes("goed"))).toBe(true);
    expect(r.criteria.find((c) => c.key === "naturalness")!.evidence[0]!.quote).toContain("友達");
    const p = r.criteria.find((c) => c.key === "pronunciation_proxy")!;
    expect(p.proxy).toMatch(/no acoustic/);
    expect(r.questions).toBeUndefined();
  });
  it("parseEvaluationResult validates LLM evidence quotes against the transcript and reports dropped ones", () => {
    const inp = input(ABSTRACT);
    const raw = JSON.stringify({
      overall: 70, clarity: 70, specificity: 55, structure: 60, relevance: 75, fluency: 80, feedback: ["x"], improvedAnswer: "y",
      criteria: [
        { key: "specificity", score: 55, evidence: [{ turnIndex: 1, quote: "なんとかチームで解決しました" }, { turnIndex: 1, quote: "頑張って解決した（言い換え）" }], explanation: "abstract", improvement: "add numbers" },
        { key: "bogus", score: 10, evidence: [], explanation: "", improvement: "" },
        { key: "relevance", score: 75, evidence: [{ turnIndex: 0, quote: "納品が2週間遅れていました" }], explanation: "ok", improvement: "ok" },
      ],
    });
    const r = parseEvaluationResult(raw, "test", inp);
    expect(r.criteria.map((c) => c.key)).toEqual(["specificity", "relevance"]);
    expect(r.criteria[0]!.evidence).toEqual([{ turnIndex: 1, quote: "なんとかチームで解決しました" }]);
    expect(r.criteria[1]!.evidence).toEqual([{ turnIndex: 3, quote: "納品が2週間遅れていました" }]); // wrong index re-anchored
    expect(r.warnings!.length).toBe(2);
    expect(r.speech.wordsPerTurn).toBeGreaterThan(0);
    expect(r.questions!.length).toBe(2);
  });
  it("prompt carries the evidence rule and numbered lines; validateEvidence drops empties", () => {
    const p = buildEvaluationPrompt(input(GOOD));
    expect(p.system).toContain("evidence[].quote");
    expect(p.user).toContain("[1] USER:");
    const w: string[] = [];
    expect(validateEvidence(input(GOOD), [{ turnIndex: 1, quote: "" }, { turnIndex: 9, quote: "zzz" }], w)).toEqual([]);
    expect(w.length).toBe(1);
    expect(speechMetrics(input(GOOD), true).interruptions).toBe(0);
    expect(questionBreakdown(input(GOOD), true)[0]!.star.result).toBe(true);
  });
});

describe("isJapanese with a missing language tag", () => {
  it("falls back to the transcript instead of throwing", () => {
    // A session evaluated without a language tag used to crash the broker with 502 and lose the result screen.
    expect(isJapanese(undefined, "こんにちは")).toBe(true);
    expect(isJapanese(undefined, "hello there")).toBe(false);
    expect(isJapanese("")).toBe(false);
  });
});

describe("evaluator prompt with a long session", () => {
  it("keeps a bounded window and preserves original turn indices", async () => {
    const { buildEvaluationPrompt } = await import("./prompt.js");
    const transcript = Array.from({ length: 400 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `発話${i}` }));
    const { user } = buildEvaluationPrompt({
      mode: "free_talk", language: "ja-JP", transcript,
      timing: { responseLatenciesMs: [], userSilencesMs: [], userSpeechDurationsMs: [], assistantSpeechDurationsMs: [] },
      interruptions: { byUser: 0, byAssistant: 0 },
    });
    expect(user).toContain("前半 240 行は省略");
    expect(user).toContain("[399]");   // original index, so evidence turnIndex stays valid
    expect(user).not.toContain("[100]");
  });
});
