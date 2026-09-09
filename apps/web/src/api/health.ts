import type { Availability } from "../state/settings.js";

export interface BrokerHealth {
  ok: boolean;
  providers: { openai: boolean; google: boolean; livekit: boolean; heygen: boolean; tavus: boolean };
  /** Meeting connector readiness (Recall key + public URLs) — see docs/integration-contracts.md "Meeting". */
  meeting?: { attendee?: boolean; recall: boolean; recallPublicUrl: boolean; recallBotPageUrl: boolean };
}
export interface AgentHealth {
  ok: boolean;
  strictLocalCapable?: boolean;
  stt: { engine: string; ready: boolean };
  llm: { engine: string; ready: boolean; model?: string };
  tts: { engine: string; ready: boolean; voice?: string; voices?: string[] };
}

export function agentHttpUrl(agentUrl: string): string {
  return agentUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/$/, "");
}

async function getJson<T>(url: string, timeoutMs = 2500): Promise<T | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Under strict_local the broker (cloud gateway) is never contacted and the agent is probed only on loopback. */
export async function probe(brokerUrl: string, agentUrl: string, privacyMode: string): Promise<{ broker: BrokerHealth | null; agent: AgentHealth | null; availability: Availability }> {
  const strict = privacyMode === "strict_local";
  const [broker, agent] = await Promise.all([
    strict ? Promise.resolve(null) : getJson<BrokerHealth>(`${brokerUrl.replace(/\/$/, "")}/health`),
    strict && !isLoopbackUrl(agentHttpUrl(agentUrl)) ? Promise.resolve(null) : getJson<AgentHealth>(`${agentHttpUrl(agentUrl)}/health`),
  ]);
  return {
    broker,
    agent,
    availability: {
      openai: !!broker?.providers.openai,
      google: !!broker?.providers.google,
      local: !!agent?.ok,
    },
  };
}

/** Surface BLOCKED_BY_* codes returned by services as readable errors. */
export async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string; message?: string };
    return j.error ?? j.message ?? `${res.status}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}
