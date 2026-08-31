import { useEffect, useState } from "react";
import {
  blocksToText,
  clockLabel,
  failureSentence,
  groupUtterances,
  meetingsApi,
  statusJa,
  timeLabel,
  type DialogueBlock,
  type MeetingRecord,
} from "../api/meetings.js";
import type { Settings } from "../state/settings.js";

export interface MeetingDetailProps {
  settings: Settings;
  meetingId: string;
  onBack: () => void;
}

/** The persisted output: what was said, readable, with the failure (if any) said in one sentence. */
export function MeetingDetail(p: MeetingDetailProps) {
  const [loading, setLoading] = useState(true);
  const [meeting, setMeeting] = useState<MeetingRecord | null>(null);
  const [blocks, setBlocks] = useState<DialogueBlock[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      try {
        const m = await meetingsApi.get(p.settings.brokerUrl, p.meetingId);
        if (!alive) return;
        setMeeting(m);
        if (m.hasTranscript) {
          try {
            const t = await meetingsApi.transcript(p.settings.brokerUrl, p.meetingId);
            if (alive) setBlocks(groupUtterances(t));
          } catch (e) {
            if (alive) setTranscriptError(e instanceof Error ? e.message : String(e));
          }
        }
      } catch (e) {
        if (alive) setError("この会議の記録を取得できませんでした。");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [p.settings.brokerUrl, p.meetingId]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(blocksToText(blocks));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const failure = meeting ? failureSentence(meeting) : null;

  return (
    <div className="page">
      <p className="page__eyebrow">会議の記録</p>
      <h1 className="page__title">{meeting?.title ?? (loading ? "読み込んでいます…" : "会議")}</h1>
      {meeting && (
        <p className="page__lede" title={meeting.statusSubCode}>
          {timeLabel(meeting.updatedAt || meeting.createdAt)} · {statusJa(meeting.status)}
          {meeting.source === "calendar" ? " · カレンダーから手配" : " · URL から手配"}
        </p>
      )}

      {error && <p className="err">{error}</p>}
      {failure && <p className="notice">{failure}</p>}

      {loading ? (
        <p className="empty">読み込んでいます…</p>
      ) : !meeting?.hasTranscript ? (
        <p className="empty">この会議の文字起こしはありません。</p>
      ) : transcriptError ? (
        <p className="empty" title={transcriptError}>文字起こしを読み込めませんでした。</p>
      ) : blocks.length === 0 ? (
        <p className="empty">発言は記録されませんでした。</p>
      ) : (
        <>
          <div className="dialogue">
            {blocks.map((b, i) => (
              <div className="dialogue__block" key={i}>
                <span className="dialogue__who">
                  {b.speaker}
                  {b.startMs !== undefined && <span className="mono dialogue__at">{clockLabel(b.startMs)}</span>}
                </span>
                <p className="dialogue__text">{b.text}</p>
              </div>
            ))}
          </div>
          <div className="page__actions">
            <button type="button" className="btn btn--ghost" onClick={p.onBack}>戻る</button>
            <button type="button" className="btn" onClick={() => void copy()}>{copied ? "コピーしました" : "全文をコピー"}</button>
          </div>
        </>
      )}

      {(loading || !meeting?.hasTranscript || blocks.length === 0) && (
        <div className="page__actions">
          <button type="button" className="btn btn--ghost" onClick={p.onBack}>戻る</button>
        </div>
      )}
    </div>
  );
}
