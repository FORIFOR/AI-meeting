import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AvatarState } from "@rcai/avatar-core";
import { VoiceOrb } from "../components/VoiceOrb.js";
import { SILENT_VOICE } from "../session/voiceActivity.js";
import "./orb-preview.css";

function Preview() {
  const [mode, setMode] = useState<"listening" | "thinking" | "speaking" | "idle" | "muted">("thinking");
  const [level, setLevel] = useState(.55);
  const latest = useRef({ mode, level });
  latest.current = { mode, level };
  const state: AvatarState = mode === "listening" ? "LISTENING" : mode === "thinking" ? "THINKING" : mode === "speaking" ? "SPEAKING" : "IDLE";
  return <main>
    <header><a href="/">AI Meeting</a><span>VOICE EXPERIENCE</span></header>
    <section className="orb-preview">
      <p className="eyebrow">声の流れが、見える。</p><h1>聞く。考える。話す。</h1>
      <p className="lede">声とともに変化する、液体ガラスのオーブ。</p>
      <VoiceOrb className="voice-orb--preview" avatarState={state} phase="live" muted={mode === "muted"} readLevels={() => {
        const p = latest.current;
        return p.mode === "listening" ? { input: p.level, output: 0, playing: false } : p.mode === "speaking" ? { input: 0, output: p.level, playing: true } : SILENT_VOICE;
      }} />
      <div className="orb-preview__states" aria-label="表示状態">
        {([["listening", "音声入力"], ["thinking", "推論中"], ["speaking", "音声出力"], ["idle", "待機"], ["muted", "ミュート"]] as const).map(([key, label]) => <button key={key} aria-pressed={mode === key} onClick={() => setMode(key)}>{label}</button>)}
      </div>
      <label className="orb-preview__level">サンプル音量<input aria-label="サンプル音量" type="range" min="0" max="1" step=".01" value={level} disabled={mode !== "listening" && mode !== "speaking"} onChange={e => setLevel(Number(e.target.value))}/></label>
      <p className="orb-preview__note">表示サンプルです。マイクの使用・音声送信・AIの呼び出しは行いません。<br/>会話画面では、実際の音声と処理状態に連動します。</p>
      <a className="orb-preview__back" href="/">AI Meeting を開く <span aria-hidden="true">↗</span></a>
    </section>
  </main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode><Preview /></StrictMode>);
import.meta.hot?.dispose(() => root.unmount());
