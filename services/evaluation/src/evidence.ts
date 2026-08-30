import type { EvaluationInput, EvaluationResult } from "@rcai/provider-core";

/**
 * Evidence-based evaluation (additive to spec §21). Every criterion carries verbatim quotes
 * from the user's own turns so the learner can see *where* a score came from.
 */
export type CriterionKey =
  | "relevance"
  | "specificity"
  | "star_structure"
  | "logical_clarity"
  | "conciseness"
  | "confidence"
  | "pronunciation_proxy"
  | "fluency"
  | "grammar"
  | "vocabulary"
  | "naturalness";

export interface EvidenceSpan {
  /** Index into `EvaluationInput.transcript`. */
  turnIndex: number;
  /** Verbatim substring of that turn's text. */
  quote: string;
}

export interface Criterion {
  key: CriterionKey;
  score: number;
  evidence: EvidenceSpan[];
  explanation: string;
  improvement: string;
  /** Present when a score is only an approximation (e.g. pronunciation without an acoustic engine). */
  proxy?: string;
}

export interface SpeechMetrics {
  /** JP: chars/s, EN: words/s of user speech. */
  paceCharsPerSec: number | null;
  pauseMeanMs: number | null;
  /** fillers per clause (~40 JP chars / ~15 EN words). */
  fillerRate: number;
  fillerCount: number;
  interruptions: number;
  answerDurationMeanMs: number | null;
  wordsPerTurn: number;
}

export interface QuestionBreakdown {
  questionTurn: number;
  answerTurn: number;
  question: string;
  answer: string;
  relevance: number;
  specificity: number;
  star: { situation: boolean; task: boolean; action: boolean; result: boolean };
  issues: string[];
}

/** §21 result + evidence. Providers return `EvaluationResult`; the extra fields ride along structurally. */
export interface EvidenceEvaluation extends EvaluationResult {
  criteria: Criterion[];
  speech: SpeechMetrics;
  questions?: QuestionBreakdown[];
  warnings?: string[];
}

export const CRITERION_LABEL: Record<CriterionKey, { ja: string; en: string }> = {
  relevance: { ja: "質問への的確さ", en: "Answer relevance" },
  specificity: { ja: "具体性", en: "Specificity" },
  star_structure: { ja: "STAR構成", en: "STAR structure" },
  logical_clarity: { ja: "論理の明瞭さ", en: "Logical clarity" },
  conciseness: { ja: "簡潔さ", en: "Conciseness" },
  confidence: { ja: "自信・言い切り", en: "Confidence" },
  pronunciation_proxy: { ja: "発音（推定）", en: "Pronunciation (proxy)" },
  fluency: { ja: "流暢さ", en: "Fluency" },
  grammar: { ja: "文法", en: "Grammar" },
  vocabulary: { ja: "語彙", en: "Vocabulary" },
  naturalness: { ja: "自然さ", en: "Naturalness" },
};

export const INTERVIEW_CRITERIA: CriterionKey[] = ["relevance", "specificity", "star_structure", "logical_clarity", "conciseness", "confidence"];
export const ENGLISH_CRITERIA: CriterionKey[] = ["fluency", "grammar", "vocabulary", "naturalness", "pronunciation_proxy"];

export function isEvidenceEvaluation(r: EvaluationResult | null | undefined): r is EvidenceEvaluation {
  return !!r && Array.isArray((r as EvidenceEvaluation).criteria) && typeof (r as EvidenceEvaluation).speech === "object";
}

/** Keep only quotes that are verbatim substrings of the referenced turn (or any user turn when the index is off). */
export function validateEvidence(input: EvaluationInput, spans: EvidenceSpan[], warnings: string[]): EvidenceSpan[] {
  const out: EvidenceSpan[] = [];
  for (const s of spans) {
    const quote = (s.quote ?? "").trim();
    if (!quote) continue;
    const turn = input.transcript[s.turnIndex];
    if (turn && turn.text.includes(quote)) {
      out.push({ turnIndex: s.turnIndex, quote });
      continue;
    }
    const idx = input.transcript.findIndex((t) => t.role === "user" && t.text.includes(quote));
    if (idx >= 0) out.push({ turnIndex: idx, quote });
    else warnings.push(`dropped non-verbatim evidence quote: "${quote.slice(0, 40)}"`);
  }
  return out;
}
