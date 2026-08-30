/** Human Reality Gate observations (docs/human-gate.md). Lives in localStorage during a session. */
export interface GateEntry {
  at: number;
  kind: "observation" | "rating" | "note";
  tag?: string;
  avatarState?: string;
  captions?: string[];
  rating?: Record<string, number>;
  note?: string;
  mode?: string;
  characterId?: string;
  providerId?: string;
}

export const GATE_TAGS = ["口パクが変", "頷きすぎ", "視線が怖い", "瞬きが規則的", "身体が止まる", "同じmotionが目につく", "聞いている感じがない", "返答が長い", "相槌が多い", "割り込みが変", "発話開始が遅い", "👍良い瞬間"] as const;
export const RATING_AXES: { key: string; ja: string }[] = [
  { key: "listening", ja: "聞いている様子の自然さ" },
  { key: "presence", ja: "そこにいる感じ" },
  { key: "latency", ja: "応答の速さ" },
  { key: "japanese", ja: "日本語の自然さ" },
];
const KEY = "rcai.humangate.v1";

export function loadGate(storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): GateEntry[] {
  try {
    const raw = storage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as GateEntry[]) : [];
  } catch {
    return [];
  }
}
export function saveGate(entries: GateEntry[], storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): void {
  try {
    storage?.setItem(KEY, JSON.stringify(entries.slice(-500)));
  } catch {
    /* quota */
  }
}
export function clearGate(storage: Pick<Storage, "removeItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Sends entries to the broker unless strict_local (then they stay in the browser only). */
export async function submitGate(brokerUrl: string, privacyMode: string, entries: GateEntry[]): Promise<"sent" | "local-only" | "failed"> {
  if (privacyMode === "strict_local") return "local-only";
  try {
    const res = await fetch(`${brokerUrl.replace(/\/$/, "")}/api/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries }) });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
