import type { EvaluationInput } from "@rcai/provider-core";
import { isJapanese, tokens } from "./heuristic.js";
import type { EvaluationProfile } from "./record.js";
import type { Criterion, EvidenceSpan, QuestionBreakdown, SpeechMetrics } from "./evidence.js";

/* ---------- lexicons ---------- */
const JA_FILLERS = /(えーっと|えーと|ええと|えっと|えー+|あのー+|あの+|そのー+|なんか|まあ+|うーん+)/g;
const EN_FILLERS = /\b(um+|uh+|erm|hmm+|you know|kind of|sort of|basically|literally|like,)\b/gi;
const JA_HEDGES = /(かもしれない|かもしれません|たぶん|多分|と思います|気がします|なんとなく|一応|とりあえず|かな[と。、]|でしょうか)/g;
const EN_HEDGES = /\b(maybe|perhaps|i guess|i think|probably|kind of|sort of|not sure|i suppose)\b/gi;
const JA_ABSTRACT = /(なんとか|いろいろ|色々|いい感じ|うまく(いき|やり|やっ)|頑張(り|っ)|一生懸命|みんなで|チームで(解決|対応)|しっかり|ちゃんと|適切に|それなり)/g;
const EN_ABSTRACT = /\b(somehow|various|a lot of things|worked hard|did my best|handled it|took care of it|figured it out|properly|appropriately|kind of worked)\b/gi;
const JA_NUMBER = /(\d+(?:[.,]\d+)?|[一二三四五六七八九十百千万]+)\s*(人|名|件|%|％|パーセント|倍|割|万円|億|円|年|か月|ヶ月|週間|日|時間|回|社|カ国|ユーザー|件数)/g;
const EN_NUMBER = /\b\d+(?:[.,]\d+)?\s*(%|percent|people|users|customers|months|years|weeks|days|hours|x|times|k|m|million|dollars|\$)?\b/gi;
const JA_SITUATION = /(当時|前職|在籍|時代|背景|状況|その頃|プロジェクトで|担当していた|チームで(は|、))/;
const JA_TASK = /(課題|問題|目標|ミッション|求められ|必要があ|しなければ|遅れ|不足|ボトルネック)/;
const JA_ACTION = /(私は|私が|自分が|自分で|提案し|実施し|導入し|作成し|設計し|交渉し|分析し|改善し|決め|率い|まとめ|働きかけ|取り組)/;
const JA_RESULT = /(結果|その結果|結果として|最終的に|達成|短縮|向上|削減|増加|改善され|成功|評価され|%|％|倍)/;
const EN_SITUATION = /\b(at my (previous|last) (job|company)|at the time|back then|the situation|context|when i was|in my role)\b/i;
const EN_TASK = /\b(the (challenge|task|problem|goal) was|needed to|had to|responsible for|behind schedule|shortage|bottleneck)\b/i;
const EN_ACTION = /\b(i (proposed|implemented|built|designed|negotiated|analyzed|led|organized|decided|created|introduced|reached out|took))\b/i;
const EN_RESULT = /\b(as a result|the result|eventually|achieved|reduced|improved|increased|cut|saved|succeeded|was recognized|%|percent)\b/i;
const JA_STRUCTURE = /(結論から|結論は|まず|次に|最後に|理由は|なぜなら|というのも|具体的には|例えば|たとえば|その結果|要するに|まとめると|第一に|第二に|ポイントは)/g;
const EN_STRUCTURE = /\b(first(ly)?|second(ly)?|finally|because|the reason|for example|for instance|specifically|as a result|in conclusion|to summarize|in short|therefore|the point is)\b/gi;
const JA_CONTRADICTION = /(でも|しかし|けど|ただ|逆に).{0,12}(でも|しかし|けど|ただ)/;
const SENTENCE_SPLIT = /(?<=[。！？!?\.])\s*/;

function count(re: RegExp, text: string): number {
  re.lastIndex = 0;
  return (text.match(re) ?? []).length;
}
function first(re: RegExp, text: string): string | null {
  re.lastIndex = 0;
  const m = re.exec(text);
  return m ? m[0] : null;
}
function clamp(v: number): number {
  return Math.round(Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0)));
}
function textLength(text: string, ja: boolean): number {
  return ja ? text.replace(/\s/g, "").length : text.split(/\s+/).filter(Boolean).length;
}
function sentences(text: string): string[] {
  return text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
}
/** Sentence (or clause) that contains the match, as a verbatim quote from the turn. */
function quoteAround(text: string, match: string, maxLen = 60): string {
  const i = text.indexOf(match);
  if (i < 0) return match;
  const s = sentences(text).find((x) => x.includes(match));
  if (s && s.length <= maxLen) return s;
  const start = Math.max(0, i - 18);
  const end = Math.min(text.length, i + match.length + 18);
  return text.slice(start, end);
}
function overlapRatio(question: string, answer: string, ja: boolean): number {
  const q = new Set(tokens(question, ja));
  if (q.size === 0) return 0.5;
  const a = new Set(tokens(answer, ja));
  let hit = 0;
  for (const t of q) if (a.has(t)) hit++;
  return hit / q.size;
}

interface UserTurn {
  index: number;
  text: string;
  question: string;
  questionIndex: number;
}

function userTurns(input: EvaluationInput): UserTurn[] {
  const out: UserTurn[] = [];
  let lastQ = "";
  let lastQi = -1;
  input.transcript.forEach((t, i) => {
    if (t.role === "assistant") {
      lastQ = t.text;
      lastQi = i;
    } else if (t.text.trim()) out.push({ index: i, text: t.text, question: lastQ, questionIndex: lastQi });
  });
  return out;
}

export function speechMetrics(input: EvaluationInput, ja: boolean): SpeechMetrics {
  const turns = userTurns(input);
  const total = turns.reduce((s, t) => s + textLength(t.text, ja), 0);
  const fillerCount = turns.reduce((s, t) => s + count(ja ? JA_FILLERS : EN_FILLERS, t.text), 0);
  const unit = ja ? 40 : 15;
  const durations = input.timing.userSpeechDurationsMs;
  const secs = durations.reduce((s, v) => s + v, 0) / 1000;
  const pauses = input.timing.userSilencesMs;
  return {
    paceCharsPerSec: secs > 0 && total > 0 ? Math.round((total / secs) * 10) / 10 : null,
    pauseMeanMs: pauses.length ? Math.round(pauses.reduce((s, v) => s + v, 0) / pauses.length) : null,
    fillerRate: Math.round((fillerCount / Math.max(1, total / unit)) * 100) / 100,
    fillerCount,
    interruptions: input.interruptions.byUser + input.interruptions.byAssistant,
    answerDurationMeanMs: durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : null,
    wordsPerTurn: turns.length ? Math.round(total / turns.length) : 0,
  };
}

export function questionBreakdown(input: EvaluationInput, ja: boolean): QuestionBreakdown[] {
  return userTurns(input)
    .filter((t) => t.questionIndex >= 0)
    .map((t) => {
      const star = {
        situation: (ja ? JA_SITUATION : EN_SITUATION).test(t.text),
        task: (ja ? JA_TASK : EN_TASK).test(t.text),
        action: (ja ? JA_ACTION : EN_ACTION).test(t.text),
        result: (ja ? JA_RESULT : EN_RESULT).test(t.text),
      };
      const numbers = count(ja ? JA_NUMBER : EN_NUMBER, t.text);
      const abstract = count(ja ? JA_ABSTRACT : EN_ABSTRACT, t.text);
      const ov = overlapRatio(t.question, t.text, ja);
      const issues: string[] = [];
      if (ov < 0.2) issues.push(ja ? "質問の焦点からずれている" : "drifts from the question");
      if (numbers === 0) issues.push(ja ? "数字がない" : "no numbers");
      if (abstract > 0) issues.push(ja ? "結果の説明が抽象的" : "abstract result");
      if (!star.result) issues.push(ja ? "結果(R)が語られていない" : "no result (R)");
      if (!star.action) issues.push(ja ? "自身の行動(A)が不明確" : "own action (A) unclear");
      return {
        questionTurn: t.questionIndex,
        answerTurn: t.index,
        question: t.question,
        answer: t.text,
        relevance: clamp(45 + ov * 130 - (textLength(t.text, ja) < (ja ? 8 : 3) ? 25 : 0)),
        specificity: clamp(40 + Math.min(30, numbers * 12) - Math.min(25, abstract * 10) + (star.result ? 10 : 0) + (star.action ? 8 : 0)),
        star,
        issues,
      };
    });
}

/** Interview criteria with verbatim evidence. */
export function interviewCriteria(input: EvaluationInput, ja: boolean, qb: QuestionBreakdown[], speech: SpeechMetrics): Criterion[] {
  const turns = userTurns(input);
  const T = (jaText: string, enText: string) => (ja ? jaText : enText);
  const out: Criterion[] = [];
  if (turns.length === 0) return out;
  const allText = turns.map((t) => t.text).join("\n");

  // relevance
  {
    const worst = [...qb].sort((a, b) => a.relevance - b.relevance)[0];
    const score = qb.length ? clamp(qb.reduce((s, q) => s + q.relevance, 0) / qb.length) : 50;
    const ev: EvidenceSpan[] = worst && worst.relevance < 70 ? [{ turnIndex: worst.answerTurn, quote: sentences(worst.answer)[0] ?? worst.answer.slice(0, 60) }] : [];
    out.push({
      key: "relevance", score, evidence: ev,
      explanation: worst && worst.relevance < 70 ? T(`「${worst.question.slice(0, 30)}…」への回答が質問の語彙とほとんど重なっていません。`, `The answer to "${worst.question.slice(0, 40)}…" barely overlaps the question's key words.`) : T("各質問の焦点に沿って答えられています。", "Answers stay on the question's focus."),
      improvement: T("回答の冒頭で質問のキーワードを繰り返し、聞かれたことに一文で答えてから補足する。", "Open by echoing the question's key words; answer in one sentence, then elaborate."),
    });
  }
  // specificity
  {
    const ev: EvidenceSpan[] = [];
    let abstractHits = 0;
    let numbers = 0;
    for (const t of turns) {
      numbers += count(ja ? JA_NUMBER : EN_NUMBER, t.text);
      const m = first(ja ? JA_ABSTRACT : EN_ABSTRACT, t.text);
      if (m) {
        abstractHits++;
        if (ev.length < 3) ev.push({ turnIndex: t.index, quote: quoteAround(t.text, m) });
      }
    }
    const score = clamp(45 + Math.min(35, numbers * 9) - Math.min(30, abstractHits * 12));
    out.push({
      key: "specificity", score, evidence: ev,
      explanation: abstractHits ? T("結果や行動の説明が抽象的な箇所があります（「なんとか」「いろいろ」など）。", "Some results/actions are described abstractly (\"somehow\", \"various things\").") : numbers ? T("数字や固有名詞で裏付けられています。", "Backed by numbers and specifics.") : T("具体的な数字・固有名詞がほとんどありません。", "Few concrete numbers or names."),
      improvement: T("具体的な数値・自身の行動を追加する（例: 「3人のチームで、私はAPI設計を担当し、処理時間を40%短縮」）。", "Add concrete numbers and your own actions (e.g. \"a team of 3, I owned the API design, cut processing time by 40%\")."),
    });
  }
  // STAR structure
  {
    const ev: EvidenceSpan[] = [];
    let parts = 0;
    let n = 0;
    for (const q of qb) {
      n++;
      parts += Number(q.star.situation) + Number(q.star.task) + Number(q.star.action) + Number(q.star.result);
      if (!q.star.result && ev.length < 2) ev.push({ turnIndex: q.answerTurn, quote: sentences(q.answer).slice(-1)[0] ?? q.answer.slice(-60) });
    }
    const score = n ? clamp(30 + (parts / (n * 4)) * 70) : 50;
    const missing = qb.length ? (["situation", "task", "action", "result"] as const).filter((k) => qb.every((q) => !q.star[k])) : [];
    out.push({
      key: "star_structure", score, evidence: ev,
      explanation: missing.length ? T(`STARのうち ${missing.map((m) => ({ situation: "状況(S)", task: "課題(T)", action: "行動(A)", result: "結果(R)" })[m]).join("・")} が語られていません。`, `Missing STAR parts: ${missing.join(", ")}.`) : T("状況→課題→行動→結果の要素が揃っています。", "Situation, task, action and result are all present."),
      improvement: T("「当時の状況→求められた課題→私が取った行動→数字で示す結果」の順で1つのエピソードを話す。", "Tell one episode in order: situation → task → the action you took → the result with a number."),
    });
  }
  // logical clarity
  {
    const markers = turns.reduce((s, t) => s + count(ja ? JA_STRUCTURE : EN_STRUCTURE, t.text), 0);
    const ev: EvidenceSpan[] = [];
    let contradictions = 0;
    for (const t of turns) {
      const m = ja ? first(JA_CONTRADICTION, t.text) : null;
      if (m) {
        contradictions++;
        if (ev.length < 2) ev.push({ turnIndex: t.index, quote: quoteAround(t.text, m) });
      }
    }
    const score = clamp(45 + Math.min(40, markers * 9) - contradictions * 10);
    out.push({
      key: "logical_clarity", score, evidence: ev,
      explanation: markers ? T("「理由は」「例えば」「その結果」など論理の接続が使われています。", "Logical connectors (because / for example / as a result) are used.") : T("理由や例を示す接続語がなく、話の筋が追いにくいです。", "No connectors signal reasons or examples; the thread is hard to follow."),
      improvement: T("結論→理由→例→まとめ の4段で、各段の頭に接続語を置く。", "Use conclusion → reason → example → summary, each introduced by a connector."),
    });
  }
  // conciseness
  {
    const ev: EvidenceSpan[] = [];
    const limit = ja ? 70 : 30;
    let longCount = 0;
    for (const t of turns) {
      for (const s of sentences(t.text)) {
        if (textLength(s, ja) > limit) {
          longCount++;
          if (ev.length < 2) ev.push({ turnIndex: t.index, quote: s.slice(0, 60) });
        }
      }
    }
    const mean = speech.wordsPerTurn;
    let score = 85 - Math.min(30, longCount * 8);
    if (mean > (ja ? 180 : 90)) score -= 10;
    if (mean < (ja ? 15 : 6)) score -= 15;
    out.push({
      key: "conciseness", score: clamp(score), evidence: ev,
      explanation: longCount ? T(`一文が長い箇所が${longCount}件あります。`, `${longCount} sentence(s) run long.`) : mean < (ja ? 15 : 6) ? T("回答が短く、根拠が足りません。", "Answers are too short to carry reasons.") : T("一文一義で簡潔です。", "Concise, one idea per sentence."),
      improvement: T("一文一義。「〜で、〜で、〜」と続けず、句点で区切る。", "One idea per sentence; end it instead of chaining with \"and… and…\"."),
    });
  }
  // confidence
  {
    const ev: EvidenceSpan[] = [];
    let hedges = 0;
    let fillers = 0;
    for (const t of turns) {
      const h = first(ja ? JA_HEDGES : EN_HEDGES, t.text);
      if (h) {
        hedges += count(ja ? JA_HEDGES : EN_HEDGES, t.text);
        if (ev.length < 2) ev.push({ turnIndex: t.index, quote: quoteAround(t.text, h) });
      }
      fillers += count(ja ? JA_FILLERS : EN_FILLERS, t.text);
    }
    const clauses = Math.max(1, textLength(allText, ja) / (ja ? 40 : 15));
    const score = clamp(88 - Math.min(35, (hedges / clauses) * 40) - Math.min(25, (fillers / clauses) * 30));
    out.push({
      key: "confidence", score, evidence: ev,
      explanation: hedges ? T("「たぶん」「と思います」などの断定回避が目立ちます。", "Hedges (maybe / I think) weaken the delivery.") : T("言い切りができており、自信が伝わります。", "Decisive phrasing conveys confidence."),
      improvement: T("事実は言い切る。「〜と思います」は意見のときだけに限定する。", "State facts plainly; reserve \"I think\" for opinions."),
    });
  }
  return out;
}

/** English lesson criteria. Pronunciation is a *proxy* until an acoustic engine exists. */
export function englishCriteria(input: EvaluationInput, speech: SpeechMetrics): Criterion[] {
  const turns = userTurns(input);
  const out: Criterion[] = [];
  if (turns.length === 0) return out;
  const text = turns.map((t) => t.text).join("\n");
  const words = tokens(text, false);
  // fluency
  {
    const ev: EvidenceSpan[] = [];
    for (const t of turns) {
      const m = first(EN_FILLERS, t.text);
      if (m && ev.length < 2) ev.push({ turnIndex: t.index, quote: quoteAround(t.text, m) });
    }
    const pace = speech.paceCharsPerSec; // words/s for EN
    let score = 85 - Math.min(30, speech.fillerRate * 35);
    if (pace !== null && pace < 1.2) score -= Math.min(20, (1.2 - pace) * 25);
    if (speech.pauseMeanMs !== null && speech.pauseMeanMs > 3000) score -= 10;
    out.push({ key: "fluency", score: clamp(score), evidence: ev, explanation: speech.fillerCount ? `${speech.fillerCount} filler(s); pace ${pace ?? "?"} w/s.` : `Pace ${pace ?? "?"} w/s, few fillers.`, improvement: "Pause silently instead of \"um\"; aim for 2–3 words per second." });
  }
  // grammar
  {
    const ev: EvidenceSpan[] = [];
    const checks: { re: RegExp; note: string }[] = [
      { re: /(^|[.!?]\s+|\s)i\s/, note: 'lowercase "i"' },
      { re: /\ba [aeiou]\w+/i, note: '"a" before a vowel sound' },
      { re: /\b(goed|eated|buyed|thinked|taked|maked|comed|runned|knowed|teached)\b/i, note: "irregular past form" },
      { re: /\b(he|she|it) (go|do|have|make|want|like|need|work|say)\b/i, note: "3rd-person -s missing" },
      { re: /\b(peoples|informations|advices|furnitures|childrens)\b/i, note: "uncountable/irregular plural" },
      { re: /\b(more better|more easier|most best)\b/i, note: "double comparative" },
    ];
    let hits = 0;
    const notes: string[] = [];
    for (const t of turns) {
      for (const c of checks) {
        const m = first(c.re, t.text);
        if (m) {
          hits++;
          if (ev.length < 3) ev.push({ turnIndex: t.index, quote: quoteAround(t.text, m.trim()) });
          if (!notes.includes(c.note)) notes.push(c.note);
        }
      }
    }
    out.push({ key: "grammar", score: clamp(90 - Math.min(45, hits * 9)), evidence: ev, explanation: notes.length ? `Recurring patterns: ${notes.join("; ")}.` : "No recurring grammar pattern detected (heuristic).", improvement: notes.length ? "Fix the recurring patterns above; they matter more than one-off slips." : "Keep going; try longer sentences with because / although." });
  }
  // vocabulary
  {
    const uniq = new Set(words).size;
    const ttr = words.length ? uniq / words.length : 0;
    const advanced = count(/\b(although|however|therefore|whereas|meanwhile|significant|approach|perspective|efficient|challenge|opportunity|consider|specifically)\b/gi, text);
    const ev: EvidenceSpan[] = [];
    const repeated = /\b(very very|so so|really really|good good)\b/i;
    for (const t of turns) {
      const m = first(repeated, t.text);
      if (m && ev.length < 2) ev.push({ turnIndex: t.index, quote: quoteAround(t.text, m) });
    }
    out.push({ key: "vocabulary", score: clamp(50 + ttr * 45 + Math.min(15, advanced * 3) - ev.length * 8), evidence: ev, explanation: `Type-token ratio ${ttr.toFixed(2)}, ${uniq} distinct words.`, improvement: "Replace intensifier stacks (very very) with one precise adjective; add linking words." });
  }
  // naturalness
  {
    const ev: EvidenceSpan[] = [];
    let jp = 0;
    for (const t of turns) {
      const m = first(/[぀-ヿ一-鿿]{2,}/g, t.text);
      if (m) {
        jp++;
        if (ev.length < 2) ev.push({ turnIndex: t.index, quote: quoteAround(t.text, m) });
      }
    }
    const contractions = count(/\b(i'm|it's|don't|can't|that's|i've|we're|isn't|didn't)\b/gi, text);
    out.push({ key: "naturalness", score: clamp(80 - Math.min(30, jp * 10) + Math.min(10, contractions * 2)), evidence: ev, explanation: jp ? `Japanese slipped in ${jp} time(s).` : "Sounds conversational (contractions used).", improvement: "When a word is missing, paraphrase in English: \"it's a kind of…\", \"the thing you use to…\"." });
  }
  // pronunciation proxy
  {
    const pace = speech.paceCharsPerSec;
    const score = clamp(70 - Math.min(15, speech.fillerRate * 15) + (pace !== null && pace >= 1.5 && pace <= 3.5 ? 10 : 0));
    out.push({ key: "pronunciation_proxy", score, evidence: [], proxy: "Derived from pace and fluency only; no acoustic analysis. A dedicated Pronunciation Engine is required for real scoring.", explanation: "Proxy score — the transcript cannot reveal pronunciation.", improvement: "Record yourself and compare with the AI's audio; a pronunciation engine will replace this proxy." });
  }
  return out;
}

/** Sales / free talk get the interview set with lighter weight (no STAR). */
export function criteriaForProfile(profile: EvaluationProfile, input: EvaluationInput, ja: boolean, qb: QuestionBreakdown[], speech: SpeechMetrics): Criterion[] {
  if (profile === "english_conversation") return englishCriteria(input, speech);
  const all = interviewCriteria(input, ja, qb, speech);
  if (profile === "interview_standard") return all;
  return all.filter((c) => c.key !== "star_structure");
}
