import { TaskList } from "../components/TaskList.js";
import { useEffect, useMemo, useState } from "react";
import { CRITERION_LABEL, isEvidenceEvaluation, type EvidenceEvaluation } from "@rcai/evaluation";
import type { SessionOutcome } from "../session/SessionController.js";
import { PROVIDER_LABEL, loadSettings } from "../state/settings.js";
import { RATING_AXES, clearGate, loadGate, saveGate, submitGate, type GateEntry } from "../components/humanGateStore.js";
import { reportToMarkdown } from "@rcai/observability";

const MODE_JA: Record<string, string> = {"interview": "面接練習", "english_lesson": "英会話", "free_talk": "雑談", "sales_roleplay": "営業ロープレ", "tutor": "学習", "career": "キャリア相談", "companion": "寄り添い", "task_planning": "タスク整理"};
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
  const { record, deferred } = outcome;
  const companion = record.mode === "companion" || record.mode === "task_planning";
  const evaluation = companion ? null : outcome.evaluation;
  const minutes = record.endedAt ? (record.endedAt - record.startedAt) / 60000 : 0;
  const tr = outcome.latency.turn_response;
  const ev: EvidenceEvaluation | null = isEvidenceEvaluation(evaluation) ? evaluation : null;
  const ja = record.language.toLowerCase().startsWith("ja");
  const verdict =
    !evaluation ? "" :
    evaluation.overall >= 85 ? "とても良い受け答えでした。" :
    evaluation.overall >= 70 ? "受け答えは十分に伝わっています。" :
    evaluation.overall >= 55 ? "伝わってはいますが、もう一段はっきりできます。" :
    "まずは、答えの形を整えるところから。";
  const reading = evaluation?.feedback[0] ?? "";
  // The single most useful fix: the weakest criterion that quotes something the user actually said.
  const lead = ev?.criteria
    ? [...ev.criteria].filter((c) => c.evidence.length && c.improvement).sort((a, b) => a.score - b.score)[0]
    : undefined;

  return (
    <div className="result">
      <p className="result__meta">{MODE_JA[record.mode] ?? record.mode} · {minutes < 1 ? "1分未満" : `${minutes.toFixed(0)}分`} · {PROVIDER_LABEL[outcome.providerId]}</p>

      {companion ? (
        <p className="result__verdict">{record.mode === "task_planning" ? "今日の整理はここまで。記録したタスクを確認できます。" : "話してくれてありがとう。また話したくなったら、ここから始められます。"}</p>
      ) : evaluation ? (
        <>
          <div className="result__score">{Math.round(evaluation.overall)}</div>
          <p className="result__verdict">{verdict}</p>
          {reading && <p className="result__reading">{reading}</p>}
        </>
      ) : (
        <p className="err" style={{ marginTop: 16 }}>評価を取得できませんでした: {outcome.evaluationError ?? "unknown"}</p>
      )}
      {record.mode === "task_planning" && <TaskList tasks={outcome.tasks ?? []} />}
      {evaluation && (outcome.fallbackUsed || outcome.evaluationError) && (
        <p className="empty" >評価モデルに接続できなかったため、手元のヒューリスティック評価です。</p>
      )}

      {lead && (
        <>
          <hr className="result__hr" />
          <div className="lead">
            <p className="lead__label">いちばん効くのはここ</p>
            <p className="lead__quote">「{lead.evidence[0]!.quote}」</p>
            <p className="lead__fix">{lead.improvement}</p>
          </div>
        </>
      )}

      {evaluation && (
        <>
          <hr className="result__hr" />
          <div className="axes">
            {AXES.map((a, i) => (
              <div className="axis" key={a.key}>
                <div className="axis__v">{Math.round(evaluation[a.key])}</div>
                <div className="axis__k">{a.ja}</div>
                <div className="axis__bar"><i style={{ width: `${evaluation[a.key]}%`, animationDelay: `${80 * i}ms` }} /></div>
              </div>
            ))}
          </div>
        </>
      )}

      <hr className="result__hr" />

      {evaluation && evaluation.feedback.length > 1 && (
        <details className="disc">
          <summary>気づいたこと（{evaluation.feedback.length}）</summary>
          <div className="disc__body">
            <ul className="feedback">{evaluation.feedback.map((f, i) => <li key={i}>{f}</li>)}</ul>
            {evaluation.improvedAnswer && (
              <>
                <h4 style={{ marginTop: 22 }}>言い換えるなら</h4>
                <div className="improved">{evaluation.improvedAnswer}</div>
              </>
            )}
          </div>
        </details>
      )}

      {ev && ev.criteria.length > 0 && (
        <details className="disc">
          <summary>採点の根拠</summary>
          <div className="disc__body">
            <div className="criteria">
              {ev.criteria.map((c) => (
                <div className="criterion" key={c.key}>
                  <div className="criterion__head">
                    <div>{CRITERION_LABEL[c.key]?.[ja ? "ja" : "en"] ?? c.key}</div>
                    <div className="criterion__score">{Math.round(c.score)}</div>
                  </div>
                  {c.explanation && <div className="criterion__explain">{c.explanation}</div>}
                  {c.evidence.slice(0, 2).map((e, i) => (
                    <div className="criterion__quote" key={i}><small>該当の発話（{e.turnIndex + 1} 番目）</small>「{e.quote}」</div>
                  ))}
                  {c.improvement && <div className="criterion__fix">{c.improvement}</div>}
                  {c.proxy && <div className="criterion__proxy">参考値 — {c.proxy}</div>}
                </div>
              ))}
            </div>
            {ev.speech && (
              <div className="speech" style={{ marginTop: 18 }}>
                <span>話す速さ {ev.speech.paceCharsPerSec ?? "–"} {ja ? "字/秒" : "w/s"}</span>
                <span>間の平均 {ev.speech.pauseMeanMs ?? "–"} ms</span>
                <span>言いよどみ {ev.speech.fillerCount} 回</span>
                <span>割り込み {ev.speech.interruptions} 回</span>
                <span>回答の長さ {ev.speech.answerDurationMeanMs ?? "–"} ms</span>
                <span>1回あたり {ev.speech.wordsPerTurn} {ja ? "字" : "words"}</span>
              </div>
            )}
            {ev.warnings?.length ? <p className="empty" >評価モデルの引用のうち {ev.warnings.length} 件は発話と一致せず除外しました。</p> : null}
          </div>
        </details>
      )}

      {ev?.questions && ev.questions.length > 0 && (
        <details className="disc">
          <summary>質問ごとの評価（{ev.questions.length}）</summary>
          <div className="disc__body" style={{ overflowX: "auto" }}>
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
        </details>
      )}

      {record.mode === "english_lesson" && (
        <details className="disc">
          <summary>会話中に記録した気づき（{deferred.length}）</summary>
          <div className="disc__body">
            {deferred.length ? (
              deferred.map((d, i) => (
                <div key={i} style={{ marginBottom: 14 }}>
                  <div className="axis__k">{d.afterTurn} ターン目まで</div>
                  <ul className="feedback">{d.feedback.map((f, j) => <li key={j}>{f}</li>)}</ul>
                </div>
              ))
            ) : (
              <p className="empty">中間フィードバックはありません（短いセッションです）。</p>
            )}
          </div>
        </details>
      )}

      <details className="disc">
        <summary>会話の記録（{record.turns.length}）</summary>
        <div className="disc__body">
          <div className="transcript">
            {record.turns.length ? record.turns.map((t, i) => (
              <div key={i} className={`turn turn--${t.role}`}>
                <div className="turn__who">{t.role === "user" ? "あなた" : "AI"}</div>
                <div className="turn__text">{t.text}{t.interrupted && <span className="turn__cut">割り込み</span>}</div>
              </div>
            )) : <p className="empty">発話は記録されませんでした。</p>}
          </div>
          <div className="stats" style={{ marginTop: 20 }}>
            <div className="stat"><b>{minutes.toFixed(1)} min</b><span>長さ</span></div>
            <div className="stat"><b>{record.turns.filter((t) => t.role === "user").length}</b><span>あなたの発話</span></div>
            <div className="stat"><b>{record.interruptions.byUser}</b><span>割り込み</span></div>
            <div className="stat"><b>{ms(tr.p50)} / {ms(tr.p95)} ms</b><span>応答 p50 / p95</span></div>
          </div>
        </div>
      </details>

      <details className="disc">
        <summary>目視評価と計測</summary>
        <div className="disc__body">
          <HumanGateSummary sessionStartedAt={record.startedAt} mode={record.mode} characterId={record.characterId ?? ""} providerId={outcome.providerId} />
          {outcome.report && <SessionReportCard outcome={outcome} />}
        </div>
      </details>

      <div className="page__actions">
        <button type="button" className="btn btn--ghost" onClick={onHome}>ホームへ</button>
        <button type="button" className="btn btn--primary" onClick={onAgain}>もう一度</button>
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
      <h4>計測レポート<small>{r.provider ?? "—"} · telemetry {outcome.telemetry ?? "—"}</small></h4>
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
                <b>{i.reason}</b> <span className="gate__meta">{i.entries.length} entries · {i.userOptIn.audio ? "audio ✓" : "no media"}</span>
                {i.note && <div >{i.note}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn" onClick={() => void copy()}>レポートをコピー</button>
        {outcome.incidents.length > 0 && <button type="button" className="btn btn--ghost" onClick={() => void copyIncidents()}>incidents JSON をコピー</button>}
        {msg && <span className="hint">{msg}</span>}
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
      <h4>目視評価<small>{observations.length} 件</small></h4>
      {observations.length ? (
        <div className="gate__timeline" style={{ marginBottom: 18 }}>
          {observations.map((e, i) => (
            <div className="gate__entry" key={i}>
              <small>+{Math.max(0, Math.round((e.at - t0) / 1000))}s · {e.avatarState}</small>
              <div><b>{e.tag}</b>{e.captions?.length ? <div className="gate__meta">{e.captions.join(" / ").slice(0, 160)}</div> : null}</div>
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
        {sent && <span className="hint">{sent}</span>}
      </div>
    </div>
  );
}
