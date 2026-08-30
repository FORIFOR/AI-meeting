import type { EvaluationInput, EvaluationProvider, EvaluationResult } from "@rcai/provider-core";
import { resolveProfile, type EvaluationProfile } from "./record.js";
import type { EvidenceEvaluation } from "./evidence.js";
import { criteriaForProfile, questionBreakdown, speechMetrics } from "./evidenceHeuristic.js";

/*
 * Zero-network evaluator (spec §21 "Local"). Heuristics, not an LLM; the scores are
 * coarse but deterministic and explainable. Works for Japanese and English transcripts.
 */

const JA_FILLERS = /(えーっと|えーと|ええと|えっと|えー+|あのー+|あの+|そのー+|なんか|まあ+|うーん+|ん-+)/g;
const EN_FILLERS = /\b(um+|uh+|erm|hmm+|you know|kind of|sort of|basically|literally|like,)\b/gi;
const JA_HEDGES = /(かもしれない|かもしれません|たぶん|多分|と思います|気がします|なんとなく|一応|とりあえず)/g;
const EN_HEDGES = /\b(maybe|perhaps|i guess|i think|probably|kind of|sort of|not sure)\b/gi;
const JA_STRUCTURE = /(結論から|結論は|まず|次に|最後に|理由は|なぜなら|というのも|具体的には|例えば|たとえば|その結果|要するに|まとめると|第一に|第二に|ポイントは)/g;
const EN_STRUCTURE = /\b(first(ly)?|second(ly)?|third|finally|because|the reason|for example|for instance|specifically|as a result|in conclusion|to summarize|in short|therefore|the point is)\b/gi;
const JA_CONCRETE = /(例えば|たとえば|具体的に|実際に|実は|当時|プロジェクト|担当|経験|チーム|件|人|年|ヶ月|か月|%|％|倍)/g;
const EN_CONCRETE = /\b(for example|for instance|specifically|actually|in practice|project|team|led|built|managed|shipped|users|customers|percent|months|years|weeks)\b/gi;
const JA_CONCLUSION_START = /^(結論|はい|いいえ|私は|一番|最も|◯|◎)/;
const SENTENCE_SPLIT = /(?<=[。！？!?\.])\s*/;

export interface HeuristicOptions {
  /** Force a profile (otherwise input.evaluationProfile / mode). */
  profile?: EvaluationProfile;
}

interface QAPair {
  question: string;
  answer: string;
  index: number;
}

interface Dimensions {
  clarity: number;
  specificity: number;
  structure: number;
  relevance: number;
  fluency: number;
}

const WEIGHTS: Record<EvaluationProfile, Dimensions> = {
  interview_standard: { clarity: 0.2, specificity: 0.2, structure: 0.2, relevance: 0.25, fluency: 0.15 },
  english_conversation: { clarity: 0.25, specificity: 0.1, structure: 0.1, relevance: 0.2, fluency: 0.35 },
  sales_roleplay: { clarity: 0.2, specificity: 0.25, structure: 0.15, relevance: 0.3, fluency: 0.1 },
  free_talk: { clarity: 0.3, specificity: 0.05, structure: 0.05, relevance: 0.2, fluency: 0.4 },
};

/** Explicit language wins; the transcript is only consulted when the language tag is unknown. */
export function isJapanese(language: string, sample = ""): boolean {
  const l = language.toLowerCase();
  if (l.startsWith("ja")) return true;
  if (l.startsWith("en")) return false;
  return /[぀-ヿ一-鿿]/.test(sample);
}

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.round(Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo)));
}

function count(re: RegExp, text: string): number {
  re.lastIndex = 0;
  return (text.match(re) ?? []).length;
}

/** Content tokens: JP → char bigrams of kana/kanji runs; EN → lowercase words ≥3 chars minus stopwords. */
export function tokens(text: string, ja: boolean): string[] {
  if (ja) {
    const runs = text.replace(/[^぀-ヿ一-鿿A-Za-z0-9]/g, " ").split(/\s+/).filter(Boolean);
    const out: string[] = [];
    for (const r of runs) {
      if (/^[A-Za-z0-9]+$/.test(r)) {
        out.push(r.toLowerCase());
        continue;
      }
      if (r.length === 1) out.push(r);
      for (let i = 0; i + 1 < r.length; i++) out.push(r.slice(i, i + 2));
    }
    return out.filter((t) => !JA_STOP.has(t));
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !EN_STOP.has(w));
}

const EN_STOP = new Set(["the", "and", "you", "that", "this", "with", "for", "are", "was", "were", "have", "has", "what", "your", "about", "tell", "can", "could", "would", "please", "how", "why", "when", "where", "which", "there", "their", "they", "them", "then", "than", "into", "from", "just", "very", "really", "also", "some", "any"]);
const JA_STOP = new Set(["です", "ます", "した", "して", "いる", "ある", "こと", "もの", "それ", "これ", "あれ", "ので", "から", "けど", "でも", "ました", "ません", "でしょ", "ですか", "ますか", "ついて", "教え", "えて", "ださ", "くだ", "さい"]);

function overlap(question: string, answer: string, ja: boolean): number {
  const q = new Set(tokens(question, ja));
  if (q.size === 0) return 0.5;
  const a = new Set(tokens(answer, ja));
  let hit = 0;
  for (const t of q) if (a.has(t)) hit++;
  return hit / q.size;
}

function pairs(input: EvaluationInput): QAPair[] {
  const out: QAPair[] = [];
  let lastAssistant = "";
  input.transcript.forEach((t, i) => {
    if (t.role === "assistant") lastAssistant = t.text;
    else if (t.text.trim()) out.push({ question: lastAssistant, answer: t.text, index: i });
  });
  return out;
}

function sentences(text: string): string[] {
  return text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
}

function textLength(text: string, ja: boolean): number {
  return ja ? text.replace(/\s/g, "").length : text.split(/\s+/).filter(Boolean).length;
}

export class HeuristicEvaluator implements EvaluationProvider {
  readonly id = "local" as const;

  constructor(private readonly opts: HeuristicOptions = {}) {}

  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    return evaluateHeuristically(input, this.opts);
  }
}

export function evaluateHeuristically(input: EvaluationInput, opts: HeuristicOptions = {}): EvidenceEvaluation {
  const profile = opts.profile ?? resolveProfile(input);
  const userText = input.transcript.filter((t) => t.role === "user").map((t) => t.text).join("\n");
  const ja = isJapanese(input.language, userText);
  const qa = pairs(input);
  const feedback: string[] = [];

  if (qa.length === 0) {
    return {
      overall: 0, clarity: 0, specificity: 0, structure: 0, relevance: 0, fluency: 0,
      feedback: [ja ? "評価できる発話がありませんでした。" : "No user speech was recorded to evaluate."],
      improvedAnswer: "",
      evaluatedBy: "local:heuristic",
      criteria: [],
      speech: speechMetrics(input, ja),
      questions: [],
    };
  }

  const answers = qa.map((p) => p.answer);
  const totalLen = answers.reduce((s, a) => s + textLength(a, ja), 0);
  const avgLen = totalLen / answers.length;
  const fillerCount = answers.reduce((s, a) => s + count(ja ? JA_FILLERS : EN_FILLERS, a), 0);
  const hedgeCount = answers.reduce((s, a) => s + count(ja ? JA_HEDGES : EN_HEDGES, a), 0);
  const unit = ja ? 40 : 15; // ~one clause
  const fillerRate = fillerCount / Math.max(1, totalLen / unit); // fillers per clause
  const hedgeRate = hedgeCount / Math.max(1, totalLen / unit);
  const allSentences = answers.flatMap(sentences);
  const avgSentenceLen = allSentences.length ? allSentences.reduce((s, x) => s + textLength(x, ja), 0) / allSentences.length : avgLen;
  const longSentenceLimit = ja ? 70 : 30;

  // ---- clarity
  let clarity = 88 - Math.min(35, fillerRate * 45) - Math.min(15, hedgeRate * 25);
  if (avgSentenceLen > longSentenceLimit) clarity -= Math.min(20, (avgSentenceLen - longSentenceLimit) / (ja ? 4 : 2));
  if (avgLen < (ja ? 12 : 5)) clarity -= 15;
  clarity = clamp(clarity);

  // ---- specificity
  const concrete = answers.reduce((s, a) => s + count(ja ? JA_CONCRETE : EN_CONCRETE, a), 0);
  const numbers = answers.reduce((s, a) => s + count(/\d+|[一二三四五六七八九十百千万]+(?=[人件年月日回%％倍])/g, a), 0);
  const properNouns = answers.reduce((s, a) => s + count(ja ? /[゠-ヿ]{3,}/g : /\b[A-Z][a-z]{2,}\b/g, a), 0);
  let specificity = 42 + Math.min(30, concrete * 7) + Math.min(18, numbers * 6) + Math.min(10, properNouns * 3);
  if (avgLen < (ja ? 20 : 8)) specificity -= 20;
  if (avgLen > (ja ? 60 : 25)) specificity += 5;
  specificity = clamp(specificity);

  // ---- structure
  const structMarkers = answers.reduce((s, a) => s + count(ja ? JA_STRUCTURE : EN_STRUCTURE, a), 0);
  const conclusionFirst = answers.filter((a) => (ja ? JA_CONCLUSION_START.test(a.trim()) || /^結論/.test(a.trim()) : /^(yes|no|i (believe|would|think)|my answer|the main)/i.test(a.trim()))).length;
  const multiSentence = answers.filter((a) => sentences(a).length >= 2).length;
  let structure = 38 + Math.min(40, structMarkers * 12) + Math.min(12, conclusionFirst * 6) + Math.min(10, (multiSentence / answers.length) * 10);
  const runOn = allSentences.filter((s) => textLength(s, ja) > longSentenceLimit * 1.6).length;
  structure -= Math.min(15, runOn * 5);
  structure = clamp(structure);

  // ---- relevance
  const overlaps = qa.map((p) => (p.question ? overlap(p.question, p.answer, ja) : 0.5));
  const meanOverlap = overlaps.reduce((s, o) => s + o, 0) / overlaps.length;
  let relevance = 48 + Math.min(52, meanOverlap * 130);
  const tooShort = qa.filter((p) => textLength(p.answer, ja) < (ja ? 8 : 3)).length;
  relevance -= Math.min(25, tooShort * 8);
  relevance = clamp(relevance);

  // ---- fluency
  const silences = input.timing.userSilencesMs;
  const avgSilence = silences.length ? silences.reduce((s, v) => s + v, 0) / silences.length : 1200;
  const longSilences = silences.filter((s) => s > 4000).length;
  let fluency = 90 - Math.min(25, Math.max(0, avgSilence - 2000) / 120) - Math.min(15, longSilences * 5) - Math.min(30, fillerRate * 40);
  const durations = input.timing.userSpeechDurationsMs;
  if (durations.length && totalLen > 0) {
    const secs = durations.reduce((s, v) => s + v, 0) / 1000;
    const rate = totalLen / Math.max(1, secs); // chars/s (ja) or words/s (en)
    const [lo, hi] = ja ? [3, 9] : [1.2, 3.5];
    if (rate < lo) fluency -= Math.min(15, (lo - rate) * 6);
    else if (rate > hi) fluency -= Math.min(10, (rate - hi) * 4);
  }
  if (input.interruptions.byAssistant > 0) fluency -= Math.min(10, input.interruptions.byAssistant * 3);
  let langMix = 0;
  if (profile === "english_conversation") {
    langMix = answers.reduce((s, a) => s + count(/[぀-ヿ一-鿿]{2,}/g, a), 0);
    fluency -= Math.min(20, langMix * 5);
    const uniq = new Set(tokens(userText, false));
    const ttr = uniq.size / Math.max(1, tokens(userText, false).length);
    if (ttr < 0.35 && tokens(userText, false).length > 30) fluency -= 8;
  }
  fluency = clamp(fluency);

  const dims: Dimensions = { clarity, specificity, structure, relevance, fluency };
  const w = WEIGHTS[profile];
  const overall = clamp(Object.entries(w).reduce((s, [k, wt]) => s + dims[k as keyof Dimensions] * wt, 0));

  // ---- feedback
  const fb = (jaText: string, enText: string) => feedback.push(ja ? jaText : enText);
  if (fillerRate > 0.6) fb(`「えー」「あの」などのつなぎ言葉が多め（${fillerCount}回）。言い出す前に一拍おくと減らせます。`, `Filler words appeared ${fillerCount} times; pause briefly before speaking instead.`);
  if (hedgeRate > 0.5) fb("「たぶん」「と思います」が多く、自信が伝わりにくいです。言い切れる部分は言い切りましょう。", "Hedging phrases (maybe / I think) weaken your message. State what you are sure of directly.");
  if (avgSentenceLen > longSentenceLimit) fb("一文が長く、聞き手が追いづらいです。一文一義で区切りましょう。", "Sentences run long; split them so each carries one idea.");
  if (specificity < 65) fb("具体例・数字・固有名詞が少なめです。「例えば〜」で実際のエピソードを1つ添えましょう。", "Add concrete examples, numbers or names — one real episode per answer.");
  if (structure < 65 && (profile === "interview_standard" || profile === "sales_roleplay")) fb("結論→理由→具体例→まとめ の順で話すと構造が伝わります。", "Lead with the conclusion, then reason, example, and a one-line summary.");
  if (relevance < 65) fb("質問の焦点から少しずれた回答がありました。質問のキーワードを最初に繰り返すと軸がぶれません。", "Some answers drifted from the question; echo the question's key words at the start.");
  if (avgSilence > 3000) fb(`回答までの間が平均${Math.round(avgSilence / 100) / 10}秒とやや長めです。「そうですね、」と受けてから考えると自然です。`, `Average pause before answering was ${Math.round(avgSilence / 100) / 10}s; acknowledge first ("Good question,") then think.`);
  if (avgLen < (ja ? 20 : 8)) fb("回答が短めです。理由や背景を一言足すだけで印象が変わります。", "Answers were short; add one sentence of reason or context.");
  if (profile === "english_conversation") {
    if (langMix > 0) feedback.push(`Japanese words slipped in ${langMix} time(s). Try paraphrasing in simple English ("It's a kind of…", "I mean…").`);
    for (const note of englishDeferredNotes(userText)) feedback.push(note);
  }
  if (feedback.length === 0) fb("全体的に明瞭で構造の伝わる回答でした。この調子で具体例をさらに磨きましょう。", "Clear, well-structured answers overall. Keep sharpening the concrete examples.");
  const best = (Object.entries(dims) as [keyof Dimensions, number][]).sort((a, b) => b[1] - a[1])[0]!;
  const bestLabel: Record<keyof Dimensions, [string, string]> = { clarity: ["明瞭さ", "clarity"], specificity: ["具体性", "specificity"], structure: ["構成", "structure"], relevance: ["質問への的確さ", "relevance"], fluency: ["流暢さ", "fluency"] };
  if (best[1] >= 75) fb(`良かった点: ${bestLabel[best[0]][0]}（${best[1]}点）。`, `Strength: ${bestLabel[best[0]][1]} (${best[1]}).`);

  // ---- evidence layer (additive): criteria with verbatim quotes, per-question breakdown, speech metrics
  const speech = speechMetrics(input, ja);
  const questions = questionBreakdown(input, ja);
  const criteria = criteriaForProfile(profile, input, ja, questions, speech);
  for (const c of criteria) {
    if (c.score < 60 && c.evidence.length && feedback.length < 8) {
      const q = c.evidence[0]!.quote;
      fb(`${c.explanation} 該当発話:「${q}」→ ${c.improvement}`, `${c.explanation} Evidence: "${q}" → ${c.improvement}`);
    }
  }
  return {
    overall, ...dims,
    feedback,
    improvedAnswer: buildImprovedAnswer(qa, ja, profile),
    evaluatedBy: "local:heuristic",
    criteria,
    speech,
    questions: profile === "interview_standard" || profile === "sales_roleplay" ? questions : undefined,
  };
}

/** Deferred, batched English notes (spec §20: never per-sentence correction). */
export function englishDeferredNotes(text: string): string[] {
  const notes: string[] = [];
  if (/(^|[.!?]\s+|\s)i\s/.test(text)) notes.push('Capitalize "I" when referring to yourself.');
  if (/\ba [aeiou]\w+/i.test(text) && !/\ba (uni|use|one|eu)/i.test(text)) notes.push('Use "an" before vowel sounds ("an apple", "an idea").');
  if (/\b(goed|eated|buyed|thinked|taked|maked|comed|runned)\b/i.test(text)) notes.push("Some irregular past forms slipped: went / ate / bought / thought / took / made / came / ran.");
  if (/\b(\w+)\s+\1\b/i.test(text)) notes.push("A few repeated words in a row — slow down slightly between phrases.");
  if (/\b(very very|so so|really really)\b/i.test(text)) notes.push('Try stronger adjectives instead of "very very" (huge, exhausted, thrilled).');
  return notes;
}

export function buildImprovedAnswer(qa: QAPair[], ja: boolean, profile: EvaluationProfile): string {
  if (qa.length === 0) return "";
  const longest = [...qa].sort((a, b) => textLength(b.answer, ja) - textLength(a.answer, ja))[0]!;
  const raw = longest.answer.replace(ja ? JA_FILLERS : EN_FILLERS, "").replace(/\s{2,}/g, " ").trim();
  const parts = sentences(raw);
  const s1 = parts[0] ?? raw;
  const s2 = parts[1];
  const s3 = parts.slice(2).join(ja ? "" : " ");
  const light = profile === "free_talk";
  if (light) return raw;
  if (ja) {
    const conclusion = /^結論/.test(s1) ? s1 : `結論から言うと、${s1.replace(/[。]$/, "")}。`;
    const reason = s2 ? (/^(理由|なぜなら|というのも)/.test(s2) ? s2 : `理由は、${s2.replace(/[。]$/, "")}。`) : "理由は、（この結論に至った根拠を一言で）。";
    const example = s3 ? (/^(例えば|具体的に)/.test(s3) ? s3 : `具体的には、${s3.replace(/[。]$/, "")}。`) : "具体的には、（実際のエピソードを1つ、数字や役割を添えて）。";
    return `${conclusion}${reason}${example}${profile === "interview_standard" ? "この経験を活かして、貴社でも同じように貢献したいと考えています。" : ""}`;
  }
  const conclusion = /^(in short|my answer|yes|no)/i.test(s1) ? s1 : `In short, ${lowerFirst(s1)}`;
  const reason = s2 ? (/^(because|the reason)/i.test(s2) ? s2 : `The reason is that ${lowerFirst(s2)}`) : "The reason is that (state the key reason in one sentence).";
  const example = s3 ? (/^(for example|specifically)/i.test(s3) ? s3 : `For example, ${lowerFirst(s3)}`) : "For example, (one concrete episode with a number or a role).";
  return [conclusion, reason, example].map((s) => (/[.!?]$/.test(s) ? s : `${s}.`)).join(" ");
}

function lowerFirst(s: string): string {
  return s.length ? s[0]!.toLowerCase() + s.slice(1) : s;
}
