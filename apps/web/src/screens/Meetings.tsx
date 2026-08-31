import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_RULE,
  isFinished,
  meetingsApi,
  reasonJa,
  sortMeetings,
  splitEvents,
  statusJa,
  timeLabel,
  type CalendarEvent,
  type CalendarStatus,
  type MeetingRecord,
  type MeetingRule,
} from "../api/meetings.js";
import type { Settings } from "../state/settings.js";

export interface MeetingsProps {
  settings: Settings;
  brokerMeeting?: { recall: boolean; recallPublicUrl: boolean; recallBotPageUrl: boolean } | null;
  onOpenMeeting: (id: string) => void;
  onUrlFlow: () => void;
  onBack: () => void;
}

/** Level 1: what the character will attend, and what it already attended. */
export function Meetings(p: MeetingsProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [rule, setRule] = useState<MeetingRule>(DEFAULT_RULE);
  const [ruleDraft, setRuleDraft] = useState<{ markers: string; leadMinutes: string }>({ markers: DEFAULT_RULE.markers.join(" "), leadMinutes: String(DEFAULT_RULE.leadMinutes) });
  const [saving, setSaving] = useState(false);
  const [busyEvent, setBusyEvent] = useState<string | null>(null);

  const load = useCallback(async () => {
    const url = p.settings.brokerUrl;
    const [st, evs, ms, rl] = await Promise.allSettled([
      meetingsApi.calendarStatus(url),
      meetingsApi.calendarEvents(url),
      meetingsApi.list(url),
      meetingsApi.rule(url),
    ]);
    setStatus(st.status === "fulfilled" ? st.value : null);
    setEvents(evs.status === "fulfilled" ? evs.value : []);
    setMeetings(ms.status === "fulfilled" ? ms.value : []);
    if (rl.status === "fulfilled") {
      setRule(rl.value);
      setRuleDraft({ markers: rl.value.markers.join(" "), leadMinutes: String(rl.value.leadMinutes) });
    }
    // Only a total failure is an error worth showing; a single missing route renders as empty.
    setError(st.status === "rejected" && ms.status === "rejected" ? "会議の情報を取得できませんでした。" : null);
    setLoading(false);
  }, [p.settings.brokerUrl]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = async (e: CalendarEvent) => {
    setBusyEvent(e.id);
    try {
      if (e.eligible) await meetingsApi.optOut(p.settings.brokerUrl, e.id);
      else await meetingsApi.optIn(p.settings.brokerUrl, e.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyEvent(null);
    }
  };

  const saveRule = async () => {
    setSaving(true);
    try {
      const next: MeetingRule = {
        markers: ruleDraft.markers.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean),
        leadMinutes: Math.max(0, Number.parseInt(ruleDraft.leadMinutes, 10) || 0),
      };
      const saved = await meetingsApi.saveRule(p.settings.brokerUrl, next);
      setRule(saved ?? next);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const { upcoming } = splitEvents(events);
  const past = sortMeetings(meetings.filter(isFinished));
  const live = sortMeetings(meetings.filter((m) => !isFinished(m)));
  const connected = status?.connected === true;
  const missing = !p.brokerMeeting?.recall
    ? { text: "会議に参加する準備ができていません（キーが未設定）。", code: "BLOCKED_BY_RECALL_KEY" }
    : !p.brokerMeeting?.recallPublicUrl
      ? { text: "会議に参加する準備ができていません（公開URLが未設定）。", code: "BLOCKED_BY_RECALL_PUBLIC_URL" }
      : null;

  return (
    <div className="page">
      <p className="page__eyebrow">同席</p>
      <h1 className="page__title">会議</h1>
      <p className="page__lede">合図語のついた予定に、キャラクターが参加者として入ります。終わった会議は記録として残ります。</p>

      {missing && <p className="notice" title={missing.code}>{missing.text}</p>}
      {error && <p className="err">{error}</p>}

      {loading ? (
        <p className="empty">読み込んでいます…</p>
      ) : (
        <>
          <div className="group">
            <p className="group__title">これからの予定</p>
            {!connected ? (
              <p className="empty" title={status?.blocked ?? "calendar_not_connected"}>
                カレンダーは未接続です。接続すると、合図語（{rule.markers.join(" / ") || "#yui"}）のついた予定に自動で参加します。
              </p>
            ) : upcoming.length === 0 ? (
              <p className="empty">これからの予定はありません。</p>
            ) : (
              <div className="rows">
                {upcoming.map((e) => (
                  <div className="row" key={e.id}>
                    <span className="row__label">
                      {e.title}
                      <small>
                        {timeLabel(e.startsAt)} · <span title={e.reason}>{reasonJa(e.reason, rule)}</span>
                      </small>
                    </span>
                    <span className="row__value">
                      <span className={`chip ${e.eligible ? "is-active" : ""}`} aria-hidden="true">{e.eligible ? "参加する" : "参加しない"}</span>
                      <button
                        type="button"
                        className="btn"
                        disabled={busyEvent === e.id || !e.meetingUrl}
                        onClick={() => void toggle(e)}
                        title={e.meetingUrl ? undefined : "会議リンクがありません"}
                      >
                        {e.eligible ? "やめる" : "参加させる"}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {connected && status?.platformEmail && (
              <p className="hint">接続中のカレンダー: {status.platformEmail}{status.readyForTesting === false ? "（同期の完了待ち）" : ""}</p>
            )}
          </div>

          {live.length > 0 && (
            <div className="group">
              <p className="group__title">進行中</p>
              <div className="rows">
                {live.map((m) => (
                  <button type="button" className="row" key={m.id} onClick={() => p.onOpenMeeting(m.id)}>
                    <span className="row__label">
                      {m.title ?? m.meetingUrl}
                      <small>{statusJa(m.status)}</small>
                    </span>
                    <span className="row__value">
                      詳細 <span className="row__chev">›</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="group">
            <p className="group__title">終わった会議</p>
            {past.length === 0 ? (
              <p className="empty">まだ記録はありません。</p>
            ) : (
              <div className="rows">
                {past.map((m) => (
                  <button type="button" className="row" key={m.id} onClick={() => p.onOpenMeeting(m.id)}>
                    <span className="row__label">
                      {m.title ?? m.meetingUrl}
                      <small title={m.statusSubCode}>
                        {timeLabel(m.updatedAt || m.createdAt)} · {statusJa(m.status)} · {m.hasTranscript ? "記録あり" : "記録なし"}
                      </small>
                    </span>
                    <span className="row__value">
                      開く <span className="row__chev">›</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <details className="disc">
            <summary>参加する条件</summary>
            <div className="disc__body">
              <div className="rows">
                <div className="row">
                  <span className="row__label">
                    合図語
                    <small>予定のタイトルにこの語が入っていると参加します。空白区切りで複数指定できます。</small>
                  </span>
                  <span className="row__value">
                    <input className="input" value={ruleDraft.markers} onChange={(e) => setRuleDraft({ ...ruleDraft, markers: e.target.value })} placeholder="#yui" />
                  </span>
                </div>
                <div className="row">
                  <span className="row__label">
                    何分前に入るか
                    <small>開始時刻の何分前にキャラクターを入室させるか。</small>
                  </span>
                  <span className="row__value">
                    <input className="input" inputMode="numeric" value={ruleDraft.leadMinutes} onChange={(e) => setRuleDraft({ ...ruleDraft, leadMinutes: e.target.value })} />
                  </span>
                </div>
              </div>
              <div className="page__actions">
                <span className="hint">現在: {rule.markers.join(" / ") || "—"} · {rule.leadMinutes} 分前</span>
                <button type="button" className="btn btn--primary" disabled={saving} onClick={() => void saveRule()}>
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </details>
        </>
      )}

      <div className="page__actions">
        <button type="button" className="btn btn--ghost" onClick={p.onBack}>戻る</button>
        <button type="button" className="btn btn--ghost" onClick={p.onUrlFlow}>URL を入れて今すぐ参加</button>
      </div>
    </div>
  );
}
