import type { EvaluationInput, EvaluationResult } from "@rcai/provider-core";
import { isJapanese } from "./heuristic.js";
import { resolveProfile, type EvaluationProfile } from "./record.js";
import { ENGLISH_CRITERIA, INTERVIEW_CRITERIA, validateEvidence, type Criterion, type CriterionKey, type EvidenceEvaluation } from "./evidence.js";
import { questionBreakdown, speechMetrics } from "./evidenceHeuristic.js";

/** JSON Schema for the §21 result (used for OpenAI-compatible JSON mode + prompt). */
export const EVALUATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overall", "clarity", "specificity", "structure", "relevance", "fluency", "feedback", "improvedAnswer"],
  properties: {
    overall: { type: "integer", minimum: 0, maximum: 100 },
    clarity: { type: "integer", minimum: 0, maximum: 100 },
    specificity: { type: "integer", minimum: 0, maximum: 100 },
    structure: { type: "integer", minimum: 0, maximum: 100 },
    relevance: { type: "integer", minimum: 0, maximum: 100 },
    fluency: { type: "integer", minimum: 0, maximum: 100 },
    feedback: { type: "array", items: { type: "string" }, maxItems: 8 },
    improvedAnswer: { type: "string" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "score", "evidence", "explanation", "improvement"],
        properties: {
          key: { type: "string", enum: ["relevance", "specificity", "star_structure", "logical_clarity", "conciseness", "confidence", "pronunciation_proxy", "fluency", "grammar", "vocabulary", "naturalness"] },
          score: { type: "integer", minimum: 0, maximum: 100 },
          evidence: { type: "array", items: { type: "object", required: ["turnIndex", "quote"], properties: { turnIndex: { type: "integer" }, quote: { type: "string" } } } },
          explanation: { type: "string" },
          improvement: { type: "string" },
        },
      },
    },
  },
} as const;

/** Gemini `responseSchema` (OpenAPI subset, UPPERCASE types per https://ai.google.dev/api/generate-content). */
export const EVALUATION_GEMINI_SCHEMA = {
  type: "OBJECT",
  required: ["overall", "clarity", "specificity", "structure", "relevance", "fluency", "feedback", "improvedAnswer"],
  properties: {
    overall: { type: "INTEGER" },
    clarity: { type: "INTEGER" },
    specificity: { type: "INTEGER" },
    structure: { type: "INTEGER" },
    relevance: { type: "INTEGER" },
    fluency: { type: "INTEGER" },
    feedback: { type: "ARRAY", items: { type: "STRING" } },
    improvedAnswer: { type: "STRING" },
    criteria: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["key", "score", "evidence", "explanation", "improvement"],
        properties: {
          key: { type: "STRING" },
          score: { type: "INTEGER" },
          evidence: { type: "ARRAY", items: { type: "OBJECT", required: ["turnIndex", "quote"], properties: { turnIndex: { type: "INTEGER" }, quote: { type: "STRING" } } } },
          explanation: { type: "STRING" },
          improvement: { type: "STRING" },
        },
      },
    },
  },
} as const;

const RUBRIC: Record<EvaluationProfile, { ja: string; en: string }> = {
  interview_standard: {
    ja: "面接練習の評価。clarity=明瞭さ（つなぎ言葉・一文の長さ・言い切り）、specificity=具体性（数字・固有名詞・エピソード）、structure=構成（結論→理由→具体例→まとめ）、relevance=質問への的確さ、fluency=流暢さ（間・言い淀み・テンポ）。会話中の採点ではなく、セッション全体の振り返りとして書く。",
    en: "Interview practice. clarity=filler words, sentence length, decisiveness; specificity=numbers, names, concrete episodes; structure=conclusion→reason→example→summary; relevance=answers the actual question; fluency=pauses, hesitation, pace. Write as an end-of-session review.",
  },
  english_conversation: {
    ja: "英会話練習の評価。fluency を最重視。文法の細かい誤りは一文ずつ直さず、繰り返し出たパターンだけを feedback にまとめる（最大5件）。日本語混じりの箇所はやさしい英語の言い換えを提案する。",
    en: "English conversation practice. Weight fluency most. Do not correct sentence by sentence; batch only recurring patterns into feedback (max 5). Where Japanese slipped in, suggest a simple English paraphrase.",
  },
  sales_roleplay: {
    ja: "営業ロープレの評価。relevance=顧客の懸念に答えたか、specificity=数字・事例・比較、structure=ヒアリング→提案→クロージングの流れ、clarity=簡潔さ、fluency=切り返しの速さ。",
    en: "Sales roleplay. relevance=addressed the customer's objections; specificity=numbers, cases, comparisons; structure=discovery→proposal→close; clarity=concision; fluency=speed of response.",
  },
  free_talk: {
    ja: "雑談の軽い振り返り。減点より良かった点を中心に、短く温かく。structure/specificity は参考程度でよい。",
    en: "Light reflection on casual conversation. Focus on strengths, keep it short and warm; structure/specificity are secondary.",
  },
};

export interface EvaluationPrompt {
  system: string;
  user: string;
}

/** Most recent transcript lines handed to the evaluator; older ones are summarised away. */
const MAX_TRANSCRIPT_LINES = 160;

/** Spec §21: Evaluator prompt built from transcript + timing + interruptions (never audio). */
export function buildEvaluationPrompt(input: EvaluationInput): EvaluationPrompt {
  const profile = resolveProfile(input);
  const ja = isJapanese(input.language, input.transcript.map((t) => t.text).join(""));
  const rubric = RUBRIC[profile][ja ? "ja" : "en"];
  const schema = JSON.stringify(EVALUATION_JSON_SCHEMA);
  const keys = (profile === "english_conversation" ? ENGLISH_CRITERIA : profile === "interview_standard" ? INTERVIEW_CRITERIA : INTERVIEW_CRITERIA.filter((k) => k !== "star_structure")).join(", ");
  const evidenceRule = ja
    ? `criteria には次のキーを必ず含める: ${keys}。各 criterion の evidence[].quote は、会話ログ中の USER 発話から一字一句そのまま抜き出した部分文字列（改変・要約禁止、20〜60文字程度）で、turnIndex はその発話の行番号（0始まり、下の会話ログの [n] 表記）。explanation は「なぜその点数か」、improvement は「どう直すか」を1文で。pronunciation_proxy は音声解析なしの推定であることを explanation に明記。`
    : `criteria must contain exactly these keys: ${keys}. Each criterion's evidence[].quote MUST be a verbatim substring copied from a USER line of the transcript (no paraphrase, ~20–60 chars) and turnIndex the 0-based line number shown as [n]. explanation = why this score; improvement = how to fix, one sentence each. pronunciation_proxy must state it is an estimate without acoustic analysis.`;
  const system = ja
    ? `あなたは会話練習の評価者（Evaluator）です。会話AIとは独立して、セッション終了後にユーザーの発話だけを評価します。\n${rubric}\n各スコアは0〜100の整数。feedback は具体的で実行可能な日本語の短文を最大6件。improvedAnswer はユーザーの一番重要な回答を、同じ内容のまま理想形に書き直したもの（1〜4文）。\n${evidenceRule}\n出力は次の JSON Schema に厳密に従う JSON のみ。説明文やコードフェンスは禁止。\n${schema}`
    : `You are the Evaluator for a conversation practice session, independent from the conversation AI. Evaluate only the user's speech after the session.\n${rubric}\nScores are integers 0–100. feedback: up to 6 short, actionable items. improvedAnswer: rewrite the user's most important answer in ideal form (1–4 sentences, same content).\n${evidenceRule}\nOutput ONLY JSON that strictly follows this JSON Schema. No prose, no code fences.\n${schema}`;

  const t = input.timing;
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, v) => s + v, 0) / xs.length) : null);
  /**
   * A 30-minute session is ~400 lines; sending all of them made the request large enough that the
   * evaluator call failed and the whole result screen was lost to a 502. Keep the most recent window and
   * say so. Line numbers stay the ORIGINAL indices, because `evidence[].turnIndex` is validated against
   * `input.transcript` — renumbering would invalidate every quote.
   */
  const shown = input.transcript.length > MAX_TRANSCRIPT_LINES ? input.transcript.length - MAX_TRANSCRIPT_LINES : 0;
  const lines = input.transcript
    .map((x, i) => ({ x, i }))
    .slice(shown)
    .map(({ x, i }) => `[${i}] ${x.role === "user" ? "USER" : "AI"}${x.interrupted ? " (interrupted)" : ""}: ${x.text}`);
  if (shown > 0) lines.unshift(ja ? `（前半 ${shown} 行は省略。以下は直近の会話）` : `(${shown} earlier lines omitted; the most recent exchange follows)`);
  const meta = [
    `mode=${input.mode}`,
    `profile=${profile}`,
    `language=${input.language}`,
    input.params && Object.keys(input.params).length ? `params=${JSON.stringify(input.params)}` : "",
    `avgResponseLatencyMs=${avg(t.responseLatenciesMs) ?? "n/a"}`,
    `avgUserSilenceBeforeAnswerMs=${avg(t.userSilencesMs) ?? "n/a"}`,
    `avgUserSpeechMs=${avg(t.userSpeechDurationsMs) ?? "n/a"}`,
    `interruptionsByUser=${input.interruptions.byUser}`,
    `interruptionsByAssistant=${input.interruptions.byAssistant}`,
    input.audioMetrics?.userLevelDb !== undefined ? `userLevelDb=${Math.round(input.audioMetrics.userLevelDb)}` : "",
  ].filter(Boolean);
  const user = `${ja ? "## セッション情報" : "## Session"}\n${meta.join("\n")}\n\n${ja ? "## 会話ログ" : "## Transcript"}\n${lines.join("\n")}`;
  return { system, user };
}

export class EvaluationParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "EvaluationParseError";
  }
}

function clamp(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.max(0, Math.min(100, n)));
}

const CRITERION_KEYS: CriterionKey[] = ["relevance", "specificity", "star_structure", "logical_clarity", "conciseness", "confidence", "pronunciation_proxy", "fluency", "grammar", "vocabulary", "naturalness"];

/**
 * Tolerant parser: strips code fences/prose, clamps 0–100, fills missing fields (overall = mean if absent).
 * When `input` is given, `criteria[].evidence` quotes are validated as verbatim transcript substrings
 * (non-matching quotes are dropped and listed in `warnings`), and `speech`/`questions` are computed locally.
 */
export function parseEvaluationResult(text: string, evaluatedBy?: string, input?: EvaluationInput): EvidenceEvaluation {
  const raw = text.trim();
  let body = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(body) as Record<string, unknown>;
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      body = body.slice(start, end + 1);
      try {
        obj = JSON.parse(body) as Record<string, unknown>;
      } catch {
        obj = null;
      }
    }
  }
  if (!obj || typeof obj !== "object") throw new EvaluationParseError("evaluation response is not JSON", raw);
  const clarity = clamp(obj.clarity, 50);
  const specificity = clamp(obj.specificity, 50);
  const structure = clamp(obj.structure, 50);
  const relevance = clamp(obj.relevance, 50);
  const fluency = clamp(obj.fluency, 50);
  const overall = obj.overall === undefined ? Math.round((clarity + specificity + structure + relevance + fluency) / 5) : clamp(obj.overall);
  const feedback = Array.isArray(obj.feedback) ? obj.feedback.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 8) : typeof obj.feedback === "string" ? [obj.feedback] : [];
  const improvedAnswer = typeof obj.improvedAnswer === "string" ? obj.improvedAnswer : typeof obj.improved_answer === "string" ? obj.improved_answer : "";
  const warnings: string[] = [];
  const criteria: Criterion[] = [];
  if (Array.isArray(obj.criteria)) {
    for (const raw of obj.criteria as Record<string, unknown>[]) {
      if (!raw || typeof raw !== "object") continue;
      const key = String(raw.key ?? "") as CriterionKey;
      if (!CRITERION_KEYS.includes(key)) {
        warnings.push(`dropped unknown criterion key: ${key}`);
        continue;
      }
      const rawEv = Array.isArray(raw.evidence) ? (raw.evidence as Record<string, unknown>[]).map((e) => ({ turnIndex: Number(e?.turnIndex ?? -1), quote: String(e?.quote ?? "") })) : [];
      const evidence = input ? validateEvidence(input, rawEv, warnings) : rawEv.filter((e) => e.quote.trim());
      criteria.push({
        key,
        score: clamp(raw.score, 50),
        evidence,
        explanation: typeof raw.explanation === "string" ? raw.explanation : "",
        improvement: typeof raw.improvement === "string" ? raw.improvement : "",
        ...(key === "pronunciation_proxy" ? { proxy: "Estimated from transcript pace/fluency only; no acoustic analysis." } : {}),
      });
    }
  }
  const ja = input ? isJapanese(input.language, input.transcript.map((t) => t.text).join("")) : false;
  const speech = input ? speechMetrics(input, ja) : { paceCharsPerSec: null, pauseMeanMs: null, fillerRate: 0, fillerCount: 0, interruptions: 0, answerDurationMeanMs: null, wordsPerTurn: 0 };
  const profile = input ? resolveProfile(input) : "free_talk";
  const questions = input && (profile === "interview_standard" || profile === "sales_roleplay") ? questionBreakdown(input, ja) : undefined;
  return { overall, clarity, specificity, structure, relevance, fluency, feedback, improvedAnswer, evaluatedBy, criteria, speech, questions, ...(warnings.length ? { warnings } : {}) };
}
