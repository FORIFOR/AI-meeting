import { useEffect, useState } from "react";
import type { SettingsAction } from "../state/settings.js";
type Status = { phase: string; message: string; memoryGB: number; freeBytes: number; supported: boolean; bundled: boolean; installed: boolean; installedProfile?: string; running: boolean; recommended: string; profile?: string; downloaded?: number; total?: number };
const invoke = <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
  const bridge = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (name: string, args?: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  return bridge ? bridge.invoke(command, args) : Promise.reject(new Error("Macアプリからセットアップしてください。"));
};
const PHASES = ["checking", "downloading", "starting", "testing", "ready"];
export function LocalSetup({ dispatch, onReady }: { dispatch: (a: SettingsAction) => void; onReady: () => void }) {
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [status, setStatus] = useState<Status | null>(null);
  const [profile, setProfile] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    const poll = async () => { try { const s = await invoke<Status>("local_setup_status"); if (alive) { setStatus(s); setProfile(p => p || s.profile || s.recommended); } } catch { if (alive) setError("セットアップ機能を利用できません。最新版のMacアプリに更新してください。"); } };
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [desktop]);
  const run = async (action: "install" | "start" | "stop") => { setBusy(true); setError(""); try { if (action === "stop") await invoke("local_setup_stop"); else await invoke("local_setup_run", { action, profile }); setStatus(await invoke<Status>("local_setup_status")); } catch(e) { setError(String(e)); } finally { setBusy(false); } };
  const running = !!status?.running;
  const ready = status?.phase === "ready" && running;
  const percent = status?.total ? Math.min(100, Math.round((status.downloaded ?? 0) / status.total * 100)) : 0;
  return <section className="local-setup" aria-labelledby="local-setup-title">
    <div className="workspace-label">ON YOUR MAC</div><h2 id="local-setup-title">ローカルAIを、かんたんに。</h2>
    <p>初回だけモデルをダウンロード。導入後の1対1の会話は、クラウドAIのクレジットを使いません。</p>
    {!desktop ? <p className="notice">セットアップはMacアプリ内の「設定」から利用できます。Web版だけではPCにAIをインストールできません。</p> : <>
      <div className="local-setup__spec">{status ? <>メモリ {status.memoryGB} GB · 空き容量 {(status.freeBytes / 1e9).toFixed(1)} GB</> : "このMacの環境を確認しています…"}</div>
      <label htmlFor="local-model">このMacで使うモデル</label>
      <select id="local-model" className="select" value={profile} disabled={running || busy} onChange={e => setProfile(e.target.value)}>
        {!profile && <option value="">確認中…</option>}
        <option value="lite">軽量 · Qwen2.5 1.5B（約1.4 GB）{status?.recommended === "lite" ? " — おすすめ" : ""}</option>
        <option value="standard" disabled={(status?.memoryGB ?? 0) < 24}>標準 · Qwen2.5 7B（約4.9 GB / メモリ24 GB以上）{status?.recommended === "standard" ? " — おすすめ" : ""}</option>
      </select>
      <p className="hint">音声認識モデルを含みます。会話の速度・精度はMacとモデルによって異なります。ダウンロードは途中から再開できます。</p>
      {status && !status.supported && <p className="err">8 GB以上のメモリを搭載したMacが必要です。</p>}
      {status && !status.bundled && <p className="err">実行環境が同梱された最新版のアプリが必要です。</p>}
      <ol className="local-setup__steps">{["環境確認", "ダウンロード", "起動", "動作確認", "完了"].map((label, i) => <li key={label} className={PHASES.indexOf(status?.phase ?? "") >= i ? "is-current" : ""}>{label}</li>)}</ol>
      <p role="status" aria-live="polite">{status?.message}</p>
      {status?.phase === "downloading" && <><progress aria-label="モデルのダウンロード" max={100} value={percent} /><span> {percent}%</span></>}
      {(error || status?.phase === "error") && <p className="err" role="alert">{error || status?.message}</p>}
      <div className="actions">
        {!running && <button className="btn btn--primary" disabled={busy || !status?.supported || !status.bundled || !profile} onClick={() => void run(status?.installedProfile === profile ? "start" : "install")}>{status?.phase === "error" ? "再試行する" : status?.installed ? "モデルを確認して起動" : "ダウンロードして使う"}</button>}
        {ready && <button className="btn btn--primary" onClick={() => { dispatch({ type: "urls", agentUrl: "ws://127.0.0.1:18788", brokerUrl: "http://127.0.0.1:8787" }); dispatch({ type: "privacy", mode: "strict_local" }); onReady(); }}>ローカル会話を始める</button>}
        {running && <button className="btn" disabled={busy} onClick={() => void run("stop")}>{ready ? "ローカルAIを停止" : "中止する"}</button>}
      </div>
      <p className="hint">セットアップ完了後は次回のアプリ起動時に自動で起動します。アプリを終了すると停止します。</p>
    </>}
    <p className="hint">Meet／Zoomの会議BotとGemini Liveはクラウド機能です。ローカルモードには切り替わりません。</p>
    <details><summary>使用するモデル・ライセンス</summary><p><a href="https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF" target="_blank" rel="noreferrer">Qwen2.5</a> · <a href="https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17" target="_blank" rel="noreferrer">SenseVoice / sherpa-onnx</a>。各配布元のライセンスが適用されます。ファイルはアプリ専用領域に保存します。</p></details>
  </section>;
}
