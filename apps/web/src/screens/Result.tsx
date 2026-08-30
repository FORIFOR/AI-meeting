import { useEffect, useMemo, useState } from "react";
import { CRITERION_LABEL, isEvidenceEvaluation, type EvidenceEvaluation } from "@rcai/evaluation";
import type { SessionOutcome } from "../session/SessionController.js";
import { PROVIDER_LABEL, loadSettings } from "../state/settings.js";
import { RATING_AXES, clearGate, loadGate, saveGate, submitGate, type GateEntry } from "../components/humanGateStore.js";
import { reportToMarkdown } from "@rcai/observability";

const AXES: { key: "clarity" | "specificity" | "structure" | "relevance" | "fluency"; ja: string }[] = [
  { key: "clarity", ja: "明瞭さ" },
  { key: "specificity", ja: "具体性" },
  { key: "structure", ja: "構成" },
  { key: "relevance", ja: "関連性" },
  { key: "fluency", ja: "流暢さ" },
];

function ms(n: number) {
  return Number.isFinite(n) ? `${Math.round(n)}` : "–";
}

/** Spec §21 result — the only place scores are shown. */
export function Result({ outcome, onHome, onAgain }: { outcome: SessionOutcome; onHome: () => void; onAgain: () => void }) {
  const { record, evaluation, deferred } = outcome;
  const minutes = record.endedAt ? (record.endedAt - record.startedAt) / 60000 : 0;
  const tr = outcome.latency.turn_response;
  const ev: EvidenceEvaluation | null = isEvidenceEvaluation(evaluation) ? evaluation : null;
  const ja = record.language.toLowerCase().startsWith("ja");
  return (
    <div className="result">
      <div className="result__head">
        <div>
          <div className="card__eyebrow">Session report · {record.mode} · {PROVIDER_LABEL[outcome.providerId]}</div>
          <h2 className="result__title">おつかれさまでした。</h2>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" className="btn" onClick={onAgain}>もう一度</button>
          <button type="button" className="btn btn--primary" onClick={onHome}>ホームへ</button>
        </div>
      </div>

      {evaluation ? (
        <div className="scores">
          <div className="score score--overall">
            <div className="score__label">Overall</div>
            <div className="score__value">{Math.round(evaluation.overall)}</div>
            <div className="score__bar"><i style={{ width: `${evaluation.overall}%` }} /></div>
          </div>
          {AXES.map((a, i) => (
            <div className="score" key={a.key} style={{ animationDelay: `${80 * (i + 1)}ms` }}>
              <div className="score__label">{a.ja} · {a.key}</div>
              <div className="score__value">{Math.round(evaluation[a.key])}</div>
              <div className="score__bar"><i style={{ width: `${evaluation[a.key]}%` }} /></div>
            </div>
          ))}
        </div>
      ) : (
        <div className="err">評価を取得できませんでした: {outcome.evaluationError ?? "unknown"}</div>
      )}
      {evaluation && (outcome.fallbackUsed || outcome.evaluationError) && (
        <div className="err">評価プロバイダに接続できなかったため、ローカルのヒューリスティック評価を表示しています（{outcome.evaluationError}）。</div>
      )}

      {evaluation && (
        <div className="section">
          <h4>フィードバック <small>Feedback{evaluation.evaluatedBy ? ` · ${evaluation.evaluatedBy}` : ""}</small></h4>
          {evaluation.feedback.length ? (
            <ul className="feedback">{evaluation.feedback.map((f, i) => <li key={i}>{f}</li>)}</ul>
          ) : (
            <p className="empty">フィードバックはありません。</p>
          )}
          {evaluation.improvedAnswer && (
            <>
              <h4 style={{ marginTop: 22 }}>改善例 <small>Improved answer</small></h4>
              <div className="improved">{evaluation.improvedAnswer}</div>
            </>
          )}
        </div>
      )}

      {ev && ev.criteria.length > 0 && (
        <div className="section">
          <h4>採点根拠 <small>Criteria with evidence</small></h4>
          <div className="criteria">
            {ev.criteria.map((c) => (
              <div className="criterion" key={c.key}>
                <div className="criterion__head">
                  <div>
                    <div className="criterion__key">{c.key}</div>
                    <div>{CRITERION_LABEL[c.key]?.[ja ? "ja" : "en"] ?? c.key}</div>
                  </div>
                  <div className="criterion__score">{Math.round(c.score)}</div>
                </div>
                {c.explanation && <div style={{ fontSize: 13, color: "var(--cream-dim)" }}>{c.explanation}</div>}
                {c.evidence.slice(0, 2).map((e, i) => (
                  <div className="criterion__quote" key={i}><small>該当発話 · turn {e.turnIndex}</small>「{e.quote}」</div>
                ))}
                {c.improvement && <div className="criterion__fix">改善: {c.improvement}</div>}
                {c.proxy && <div className="criterion__proxy">PROXY — {c.proxy}</div>}
              </div>
            ))}
          </div>
          {ev.speech && (
            <div className="speech" style={{ marginTop: 16 }}>
              <span>pace {ev.speech.paceCharsPerSec ?? "–"} {ja ? "chars/s" : "w/s"}</span>
              <span>pause {ev.speech.pauseMeanMs ?? "–"} ms</span>
              <span>fillers {ev.speech.fillerCount} ({ev.speech.fillerRate}/clause)</span>
              <span>interruptions {ev.speech.interruptions}</span>
              <span>answer {ev.speech.answerDurationMeanMs ?? "–"} ms</span>
              <span>{ev.speech.wordsPerTurn} {ja ? "chars" : "words"}/turn</span>
            </div>
          )}
          {ev.warnings?.length ? <p className="empty" style={{ marginTop: 10 }}>{ev.warnings.length} evidence quote(s) from the evaluator were not verbatim and were dropped.</p> : null}
        </div>
      )}

      {ev?.questions && ev.questions.length > 0 && (
        <div className="section">
          <h4>質問ごとの評価 <small>Per question</small></h4>
          <div style={{ overflowX: "auto" }}>
            <table className="qtable">
              <thead><tr><th>質問</th><th>回答（冒頭）</th><th>的確さ</th><th>具体性</th><th>STAR</th><th>問題</th></tr></thead>
              <tbody>
                {ev.questions.map((q, i) => (
                  <tr key={i}>
                    <td>{q.question.slice(0, 40)}{q.question.length > 40 ? "…" : ""}</td>
                    <td>{q.answer.slice(0, 50)}{q.answer.length > 50 ? "…" : ""}</td>
                    <td>{q.relevance}</td>
                    <td>{q.specificity}</td>
                    <td><span className="star">{(["situation", "task", "action", "result"] as const).map((k) => <i key={k} className={q.star[k] ? "is-on" : ""}>{k[0]!.toUpperCase()}</i>)}</span></td>
                    <td>{q.issues.join(" · ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <HumanGateSummary sessionStartedAt={record.startedAt} mode={record.mode} characterId={record.characterId ?? ""} providerId={outcome.providerId} />

      {outcome.report && <SessionReportCard outcome={outcome} />}

      {record.mode === "english_lesson" && (
        <div className="section">
          <h4>会話中に記録した気づき <small>Deferred feedback (every 4 turns)</small></h4>
          {deferred.length ? (
            deferred.map((d, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <div className="radio__meta">after turn {d.afterTurn}</div>
                <ul className="feedback">{d.feedback.map((f, j) => <li key={j}>{f}</li>)}</ul>
              </div>
            ))
          ) : (
            <p className="empty">4ターンごとの中間フィードバックはありませんでした（短いセッションです）。</p>
          )}
        </div>
      )}

      <div className="section">
        <h4>セッション統計 <small>Stats</small></h4>
        <div className="stats">
          <div className="stat"><b>{minutes.toFixed(1)} min</b><span>duration</span></div>
          <div className="stat"><b>{record.turns.filter((t) => t.role === "user").length}</b><span>your turns</span></div>
          <div className="stat"><b>{record.interruptions.byUser}</b><span>barge-ins</span></div>
          <div className="stat"><b>{ms(tr.p50)} / {ms(tr.p95)} ms</b><span>response p50 / p95</span></div>
          <div className="stat"><b>{ms(outcome.latency.interrupt_stop.max)} ms</b><span>barge-in stop max</span></div>
          <div className="stat"><b>{ms(outcome.latency.listening_react.max)} ms</b><span>→ listening max</span></div>
        </div>
      </div>

      <div className="section">
        <h4>トランスクリプト <small>Transcript</small></h4>
        <div className="transcript">
          {record.turns.length ? record.turns.map((t, i) => (
            <div key={i} className={`turn turn--${t.role}`}>
              <div className="turn__who">{t.role === "user" ? "You" : "AI"}</div>
              <div className="turn__text">{t.text}{t.interrupted && <span className="turn__cut">interrupted</span>}</div>
            </div>
          )) : <p className="empty">発話は記録されませんでした。</p>}
        </div>
      </div>
    </div>
  );
}

/** Round 3 Gate 6/7: numbers-only session report + presence incidents captured with 「不自然だった瞬間」. */
function SessionReportCard({ outcome }: { outcome: SessionOutcome }) {
  const r = outcome.report!;
  const [msg, setMsg] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportToMarkdown(r));
      setMsg("レポートをコピーしました");
    } catch {
      setMsg("コピーできませんでした");
    }
  };
  const copyIncidents = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(outcome.incidents, null, 2));
      setMsg(`incidents JSON (${outcome.incidents.length}) をコピーしました`);
    } catch {
      setMsg("コピーできませんでした");
    }
  };
  const hist = r.responseLatency.histogram;
  const maxCount = Math.max(1, ...hist.map((b) => b.count));
  return (
    <div className="section">
      <h4>セッションレポート <small>Observability · {r.provider ?? "—"} · telemetry {outcome.telemetry ?? "—"}</small></h4>
      <div className="stats">
        <div className="stat"><b>{r.turns.user} / {r.turns.assistant}</b><span>turns you / AI</span></div>
        <div className="stat"><b>{ms(r.responseLatency.p50)} / {ms(r.responseLatency.p95)}</b><span>response p50 / p95 ms</span></div>
        <div className="stat"><b>{r.reconnects}</b><span>reconnects</span></div>
        <div className="stat"><b>{r.interruptions.byUser}</b><span>barge-ins</span></div>
        <div className="stat"><b>{r.staleDrops}</b><span>stale chunk drops</span></div>
        <div className="stat"><b>{ms(r.stt.p50)} / {ms(r.llmTtft.p50)} / {ms(r.ttsTtfa.p50)}</b><span>STT / TTFT / TTFA p50 ms</span></div>
        <div className="stat"><b>{ms(r.avatar.lipDelayMs.p50)} ms</b><span>audio → lip delay p50</span></div>
        <div className="stat"><b>{ms(r.avatar.frameIntervalMs.p50)} ms</b><span>avatar frame interval p50</span></div>
        <div className="stat"><b>{r.errors.count}</b><span>errors {r.errors.codes.slice(0, 3).join(", ")}</span></div>
      </div>
      <div className="histo" style={{ marginTop: 14 }}>
        {hist.map((b) => (
          <div className="histo__col" key={b.from} title={`${b.from}${b.to === null ? "+" : `–${b.to}`} ms: ${b.count}`}>
            <i style={{ height: `${Math.round((b.count / maxCount) * 40) + 2}px` }} />
            <small>{b.from >= 1000 ? `${b.from / 1000}s` : b.from}</small>
          </div>
        ))}
      </div>
      {outcome.incidents.length > 0 && (
        <div className="gate__timeline" style={{ marginTop: 16 }}>
          {outcome.incidents.map((i) => (
            <div className="gate__entry" key={i.id}>
              <small>{new Date(i.at).toLocaleTimeString()} · {i.avatarState}</small>
              <div>
                <b>{i.reason}</b> <span style={{ color: "var(--cream-mute)", fontSize: 12 }}>{i.entries.length} entries · {i.userOptIn.audio ? "audio ✓" : "no media"}</span>
                {i.note && <div style={{ fontSize: 12 }}>{i.note}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn" onClick={() => void copy()}>レポートをコピー</button>
        {outcome.incidents.length > 0 && <button type="button" className="btn btn--ghost" onClick={() => void copyIncidents()}>incidents JSON をコピー</button>}
        {msg && <span className="radio__meta">{msg}</span>}
      </div>
    </div>
  );
}

/** Human Reality Gate: observations logged during the session + end-of-session rating (docs/human-gate.md). */
function HumanGateSummary(p: { sessionStartedAt: number; mode: string; characterId: string; providerId: string }) {
  const [entries, setEntries] = useState<GateEntry[]>(() => loadGate());
  const [rating, setRating] = useState<Record<string, number>>({});
  const [sent, setSent] = useState<string | null>(null);
  const settings = useMemo(() => loadSettings(), []);
  useEffect(() => saveGate(entries), [entries]);
  const observations = entries.filter((e) => e.kind === "observation");
  const submit = async () => {
    const all: GateEntry[] = [...entries.filter((e) => e.kind !== "rating"), { at: Date.now(), kind: "rating", rating, mode: p.mode, characterId: p.characterId, providerId: p.providerId }];
    setEntries(all);
    const r = await submitGate(settings.brokerUrl, settings.privacyMode, all);
    setSent(r === "sent" ? "docs/reports/human に保存しました" : r === "local-only" ? "strict_local: ブラウザ内にのみ保存（JSON をコピーして回収）" : "broker に送信できませんでした（JSON をコピーして回収）");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ session: p, entries, rating }, null, 2));
      setSent("JSON をクリップボードにコピーしました");
    } catch {
      setSent("コピーできませんでした");
    }
  };
  const reset = () => { clearGate(); setEntries([]); setRating({}); setSent(null); };
  const t0 = observations[0]?.at ?? p.sessionStartedAt;
  return (
    <div className="section">
      <h4>目視評価 <small>Human Reality Gate · {observations.length} observations</small></h4>
      {observations.length ? (
        <div className="gate__timeline" style={{ marginBottom: 18 }}>
          {observations.map((e, i) => (
            <div className="gate__entry" key={i}>
              <small>+{Math.max(0, Math.round((e.at - t0) / 1000))}s · {e.avatarState}</small>
              <div><b>{e.tag}</b>{e.captions?.length ? <div style={{ color: "var(--cream-mute)", fontSize: 12 }}>{e.captions.join(" / ").slice(0, 160)}</div> : null}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="empty">セッション中の観察記録はありません（メニュー →「評価パネル · Human gate」）。</p>
      )}
      <div className="gate__rating">
        {RATING_AXES.map((a) => (
          <div key={a.key} style={{ display: "contents" }}>
            <span>{a.ja}</span>
            <span className="gate__stars">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" className={`gate__star ${(rating[a.key] ?? 0) >= n ? "is-on" : ""}`} onClick={() => setRating((r) => ({ ...r, [a.key]: n }))}>{n}</button>
              ))}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={!observations.length && !Object.keys(rating).length}>記録を保存</button>
        <button type="button" className="btn" onClick={() => void copy()}>JSON をコピー</button>
        <button type="button" className="btn btn--ghost" onClick={reset}>クリア</button>
        {sent && <span className="radio__meta">{sent}</span>}
      </div>
    </div>
  );
}
