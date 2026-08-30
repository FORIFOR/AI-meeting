import type { ConversationMode } from "@rcai/conversation-core";

/** The one continuation line on Home: what was practised last, with whom. */
export interface Recent {
  mode: ConversationMode;
  characterId: string;
  characterName: string;
  personaId: string;
  at: number;
}

const KEY = "rcai.recent.v1";

export function loadRecent(storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): Recent | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<Recent>;
    if (!r.mode || !r.characterId || typeof r.at !== "number") return null;
    return r as Recent;
  } catch {
    return null;
  }
}

export function saveRecent(r: Recent, storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): void {
  try {
    storage?.setItem(KEY, JSON.stringify(r));
  } catch {
    /* private mode / quota */
  }
}

/** 「昨日」「3日前」— relative, in Japanese, without a date library. */
export function whenLabel(at: number, now: number = Date.now()): string {
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) {
    const mins = Math.round((now - at) / 60_000);
    if (mins < 1) return "さっき";
    if (mins < 60) return `${mins}分前`;
    return `${Math.round(mins / 60)}時間前`;
  }
  if (days === 1) return "昨日";
  if (days < 7) return `${days}日前`;
  return `${Math.floor(days / 7)}週間前`;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
