import { useEffect, useRef, useState } from "react";
import { completeZoom, connectZoom, disconnectZoom, zoomToken } from "../api/zoom.js";
import type { PrivacyMode } from "@rcai/conversation-core";

export function ZoomReturn({ onDone, privacyMode }: { onDone: () => void; privacyMode: PrivacyMode }) {
  if (privacyMode === "strict_local") return new URLSearchParams(location.hash.slice(1)).has("zoom_oauth")
    ? <p role="status">Zoomと連携するには、設定でクラウドの利用を有効にしてください。</p> : null;
  return <CloudZoomReturn onDone={onDone} />;
}
function CloudZoomReturn({ onDone }: { onDone: () => void }) {
  const [active] = useState(() => new URLSearchParams(location.hash.slice(1)).has("zoom_oauth"));
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const doneCallback = useRef(onDone); doneCallback.current = onDone;
  useEffect(() => {
    let alive = true;
    if (active) void completeZoom().then(() => { if (alive) { setDone(true); doneCallback.current(); } }).catch(e => { if (alive) setError(String(e.message)); });
    return () => { alive = false; };
  }, [active]);
  return active && !done ? <p role="status">{error || "Zoomの連携を確認しています…"}</p> : null;
}
interface ZoomConnectionProps { base: string; meetingUrl: string; disabled: boolean; privacyMode: PrivacyMode }
export function ZoomConnection(props: ZoomConnectionProps) {
  return props.privacyMode === "strict_local" ? null : <CloudZoomConnection {...props} />;
}
function CloudZoomConnection({ base, meetingUrl, disabled }: ZoomConnectionProps) {
  const [available, setAvailable] = useState(false), [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setChecking(true);
    void fetch(`${base.replace(/\/$/, "")}/api/zoom/config`, { signal: abort.signal }).then(r => r.json()).then(async c => {
      if (abort.signal.aborted) return;
      setAvailable(!!c.available);
      if (c.available && zoomToken(base)) {
        const r = await fetch(`${base.replace(/\/$/, "")}/api/zoom/status`, { signal: abort.signal, headers: { Authorization: `Bearer ${zoomToken(base)}` } });
        const status = r.ok ? await r.json() : {};
        if (abort.signal.aborted) return;
        setConnected(status.connected === true); setDisconnectPending(status.disconnectPending === true);
      }
    }).catch(() => {}).finally(() => { if (!abort.signal.aborted) setChecking(false); });
    return () => abort.abort();
  }, [base]);
  if (!available) return null;
  return <div className="field">
    <span>{checking ? "Zoomの接続を確認しています…" : disconnectPending ? "Zoomの接続解除を確認できません。再試行してください。" : connected ? "Zoom 連携済み" : "Zoomの会議には、まずアカウントを連携してください。"}</span>
    <button type="button" className="btn btn--ghost" disabled={disabled || busy || checking} onClick={() => {
      setBusy(true); setError("");
      void (connected || disconnectPending ? disconnectZoom(base).then(() => { setConnected(false); setDisconnectPending(false); }).catch(e => { setDisconnectPending(true); throw e; }) : connectZoom(base, meetingUrl)).catch(e => setError(String(e.message))).finally(() => setBusy(false));
    }}>{disconnectPending ? "接続解除を再試行" : connected ? "Zoomの連携を解除" : "Zoomと連携"}</button>
    {error && <p role="alert" className="err">{error}</p>}
  </div>;
}
