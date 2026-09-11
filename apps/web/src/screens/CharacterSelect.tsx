import { useEffect, useRef, useState } from "react";
import type { BrokerHealth } from "../api/health.js";
import { BLOCKED_JA, PLATE, RENDERER_JA, blockedReason } from "../components/characters.js";
import { createAvatarProvider, type CharacterEntry } from "../integrations/registry.js";
import { loadCharacter } from "@rcai/avatar-core";
import { chosenAvatarQuality, type Settings, type SettingsAction } from "../state/settings.js";

const PERSONALITY: Record<string, string> = {
  sora: "3Dの会話パートナー · 日本語 / English · 試験提供",
  yui: "明るく親しみやすい · 日本語 / English",
  haru: "落ち着いていて聞き上手 · 日本語",
  reina: "きびきびと率直 · 日本語",
  kei: "穏やかで丁寧 · 日本語",
  heygen: "実写のアバター · クラウド",
  tavus: "実写のアバター · クラウド",
};

export interface CharacterSelectProps {
  characters: CharacterEntry[];
  settings: Settings;
  dispatch: (a: SettingsAction) => void;
  broker: BrokerHealth | null;
  onDone: () => void;
}

/** One character at a time — neighbours are names, not a grid of cards. */
export function CharacterSelect(p: CharacterSelectProps) {
  const oss = import.meta.env.VITE_RCAI_OSS === "true";
  const strict = p.settings.privacyMode === "strict_local";
  const list = p.characters;
  const startIndex = Math.max(0, list.findIndex((c) => c.id === p.settings.characterId));
  const [index, setIndex] = useState(startIndex);
  const current = list[Math.min(index, list.length - 1)];
  const blocked = current ? blockedReason(current, p.broker, strict) : "NO_CHARACTER";
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<"loading" | "ready" | "fallback">("loading");

  useEffect(() => {
    if (!current) return;
    const mount = previewRef.current;
    if (!mount || blocked || (current.renderer !== "live2d" && current.renderer !== "vrm" && current.renderer !== "human-glb" && current.renderer !== "canvas")) {
      setPreview("fallback");
      return;
    }
    let alive = true;
    let avatar: import("@rcai/avatar-core").AvatarProvider | null = null;
    setPreview("loading");
    void (async () => {
      try {
        const definition = await loadCharacter(current.baseUrl);
        if (!alive) return;
        avatar = await createAvatarProvider(current.renderer, {
          container: mount,
          brokerUrl: p.settings.brokerUrl,
          privacyMode: p.settings.privacyMode,
          framing: "preview",
          maxFps: 30,
        });
        await avatar.prepare(definition);
        await avatar.start();
        if (!alive) {
          await avatar.stop().catch(() => {});
          return;
        }
        setPreview("ready");
      } catch {
        if (alive) setPreview("fallback");
      }
    })();
    return () => {
      alive = false;
      if (avatar) void avatar.stop().catch(() => {});
      mount.replaceChildren();
    };
  }, [blocked, current, p.settings.brokerUrl, p.settings.privacyMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Let controls such as the display-quality radios use their native arrow keys.
      if (!list.length || e.defaultPrevented || (e.target instanceof Element && e.target.closest("input, select, textarea, [role='radiogroup']"))) return;
      if (e.key === "ArrowLeft") setIndex((i) => (i - 1 + list.length) % list.length);
      if (e.key === "ArrowRight") setIndex((i) => (i + 1) % list.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list.length]);

  if (!current) return <div className="pick"><p className="empty">キャラクターがありません。</p><button type="button" className="btn btn--ghost" onClick={p.onDone}>戻る</button></div>;

  const quality = oss ? "lightweight" : chosenAvatarQuality(p.settings, current.id);
  const natural = p.broker?.avatars?.anam;
  const naturalAvailable = !oss && !strict && natural?.configured === true && Array.isArray(natural.characterIds) && natural.characterIds.includes(current.id);
  const naturalUnavailable = oss ? "この配布版では軽量表示を使います。" : strict ? "完全ローカルでは軽量表示を使います。" : "この相手の自然な表示は準備中です。";
  const move = (d: number) => setIndex((i) => (i + d + list.length) % list.length);
  const choose = () => {
    p.dispatch({ type: "character", id: current.id });
    p.onDone();
  };

  return (
    <div className="pick">
      <p className="pick__title">話す相手を選ぶ</p>
      <div className="pick__stage">
        <div key={current.id} className={`pick__portrait ${current.id === p.settings.characterId ? "pick__portrait--accent" : ""}`} ref={previewRef} aria-label={`${current.name}のプレビュー`}>
          {preview !== "ready" && <span className="pick__glyph" aria-hidden="true">{PLATE[current.id] ?? current.name.slice(0, 1)}</span>}
          {preview === "loading" && <span className="pick__loading">プレビューを読み込み中…</span>}
        </div>
      </div>
      <h1 className="pick__name">
        {current.name}
        {current.id === p.settings.characterId && <span className="pick__current">選択中</span>}
      </h1>
      <p className="pick__desc">{PERSONALITY[current.id] ?? RENDERER_JA[current.renderer]}</p>
      {blocked && <p className="pick__blocked" title={blocked}>{BLOCKED_JA[blocked] ?? blocked}</p>}

      <div className="pick__strip">
        <button type="button" className="pick__arrow" aria-label="前の相手" onClick={() => move(-1)}>‹</button>
        {list.map((c, i) => (
          <button key={c.id} type="button" className={`pick__name-btn ${i === index ? "is-active" : ""}`} onClick={() => setIndex(i)}>
            {c.name}
          </button>
        ))}
        <button type="button" className="pick__arrow" aria-label="次の相手" onClick={() => move(1)}>›</button>
      </div>

      <fieldset className="pick__quality" aria-describedby="avatar-quality-note">
        <legend>表示品質</legend>
        <div className="pick__quality-options">
          <label className={`pick__quality-option ${quality === "lightweight" ? "is-selected" : ""}`}>
            <input type="radio" name="avatar-quality" value="lightweight" checked={quality === "lightweight"} onChange={() => p.dispatch({ type: "avatarQuality", characterId: current.id, quality: "lightweight" })} />
            <span><b>軽量表示</b><small>応答の速さを優先</small></span>
          </label>
          <label className={`pick__quality-option ${quality === "natural" ? "is-selected" : ""} ${naturalAvailable ? "" : "is-unavailable"}`}>
            <input type="radio" name="avatar-quality" value="natural" checked={quality === "natural"} disabled={!naturalAvailable} aria-describedby={`avatar-quality-transmission${naturalAvailable ? "" : " avatar-quality-unavailable"}`} onChange={() => { if (naturalAvailable) p.dispatch({ type: "avatarQuality", characterId: current.id, quality: "natural" }); }} />
            <span><b>自然な表示</b><small>AI返答音声の外部送信を許可</small></span>
          </label>
        </div>
        {!naturalAvailable && <p id="avatar-quality-unavailable">{naturalUnavailable}</p>}
        <p id="avatar-quality-transmission">自然な表示を選ぶと、AIの返答音声を外部サービスのAnamへ送信します。返答には会議内容が含まれることがあります。相手ごとに選択を保存し、次回の会話にも使います。送信をやめるには軽量表示を選んでください。</p>
        <p id="avatar-quality-note">自然な表示は試験段階です。準備や応答に時間が加わり、発話の切り替わりで軽量表示に戻ります。<br />この画面のプレビューは軽量表示です。</p>
      </fieldset>

      <div className="actions">
        <button type="button" className="btn btn--ghost" onClick={p.onDone}>戻る</button>
        <button type="button" className="btn btn--primary btn--lg" disabled={!!blocked} onClick={choose}>
          この相手にする
        </button>
      </div>
    </div>
  );
}
