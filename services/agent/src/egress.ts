import { isLoopbackUrl } from "./config.js";

/**
 * Process-level egress guard: records (and optionally blocks) any HTTP/WS request whose host is
 * not loopback. Under strict_local nothing may leave the machine (spec §6, CLAUDE.md rule 11).
 */
export interface EgressEntry {
  at: number;
  url: string;
  blocked: boolean;
}

const log: EgressEntry[] = [];
let strictBlock = false;
let installed = false;

export function getEgressLog(): EgressEntry[] {
  return [...log];
}

export function clearEgressLog(): void {
  log.length = 0;
}

export function setStrictEgressBlock(enabled: boolean): void {
  strictBlock = enabled;
}

export function installEgressGuard(): void {
  if (installed) return;
  installed = true;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isLoopbackUrl(url)) {
      const blocked = strictBlock;
      log.push({ at: Date.now(), url, blocked });
      if (blocked) throw new Error(`EGRESS_BLOCKED strict_local forbids ${url}`);
    }
    return origFetch(input, init);
  }) as typeof fetch;
  const OrigWS = globalThis.WebSocket;
  if (OrigWS) {
    const Guarded = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      const href = typeof url === "string" ? url : url.href;
      if (!isLoopbackUrl(href)) {
        const blocked = strictBlock;
        log.push({ at: Date.now(), url: href, blocked });
        if (blocked) throw new Error(`EGRESS_BLOCKED strict_local forbids ${href}`);
      }
      return new OrigWS(url, protocols);
    } as unknown as typeof WebSocket;
    Object.setPrototypeOf(Guarded, OrigWS);
    (Guarded as unknown as { prototype: unknown }).prototype = OrigWS.prototype;
    globalThis.WebSocket = Guarded;
  }
}
