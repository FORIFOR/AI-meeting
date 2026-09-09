import { useEffect, useRef, useState } from "react";
import { completeZoom, connectZoom, disconnectZoom, zoomToken } from "../api/zoom.js";

export function ZoomReturn({ onDone }: { onDone: () => void }) {
  const [active] = useState(() => new URLSearchParams(location.hash.slice(1)).has("zoom_oauth"));
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const doneCallback = useRef(onDone); doneCallback.current = onDone;
  useEffect(() => { if (active) void completeZoom().then(() => { setDone(true); doneCallback.current(); }).catch(e => setError(String(e.message))); }, [active]);
  return active && !done ? <p role="status">{error || "Zoomの連携を確認しています…"}</p> : null;
}
export function ZoomConnection({ base, meetingUrl, disabled }: { base: string; meetingUrl: string; disabled: boolean }) {
  const [available, setAvailable] = useState(false), [connected, setConnected] = useState(false);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`${base.replace(/\/$/, "")}/api/zoom/config`, { signal: abort.signal }).then(r => r.json()).then(async c => {
      setAvailable(!!c.available);
      if (c.available && zoomToken(base)) {
        const r = await fetch(`${base.replace(/\/$/, "")}/api/zoom/status`, { signal: abort.signal, headers: { Authorization: `Bearer ${zoomToken(base)}` } });
        const status = r.ok ? await r.json() : {};
        setConnected(status.connected === true); setDisconnectPending(status.disconnectPending === true);
      }
    }).catch(() => {});
    return () => abort.abort();
  }, [base]);
  if (!available) return null;
  return <div className="field">
    <span>{disconnectPending ? "Zoomの接続解除を確認できません。再試行してください。" : connected ? "Zoom 連携済み" : "Zoomの会議には、まずアカウントを連携してください。"}</span>
    <button type="button" className="btn btn--ghost" disabled={disabled || busy} onClick={() => {
      setBusy(true); setError("");
      void (connected || disconnectPending ? disconnectZoom(base).then(() => { setConnected(false); setDisconnectPending(false); }).catch(e => { setDisconnectPending(true); throw e; }) : connectZoom(base, meetingUrl)).catch(e => setError(String(e.message))).finally(() => setBusy(false));
    }}>{disconnectPending ? "接続解除を再試行" : connected ? "Zoomの連携を解除" : "Zoomと連携"}</button>
    {error && <p role="alert" className="err">{error}</p>}
  </div>;
}
