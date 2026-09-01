/**
 * RelayHub: Recall's realtime websocket (public side, /api/meeting/recall/relay/{token}/) → browser clients
 * (/api/meeting/recall/client/{botId}). Pure logic; sockets are injected so it is unit-testable.
 */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
}

export class RelayHub {
  private tokens = new Map<string, string | null>(); // token → botId (null until bound)
  private clients = new Map<string, Set<RelaySocket>>(); // botId → clients
  private pending = new Map<string, string[]>(); // botId → buffered messages before a client connects (bounded)
  private readonly maxPending = 50;

  constructor(private readonly publicClientBase: string, private readonly now: () => number = Date.now) {}

  register(token: string): void {
    this.tokens.set(token, null);
  }

  bind(token: string, botId: string): void {
    if (!this.tokens.has(token)) this.tokens.set(token, botId);
    else this.tokens.set(token, botId);
  }

  clientUrl(botId: string): string {
    return `${this.publicClientBase.replace(/\/$/, "")}/api/meeting/recall/client/${encodeURIComponent(botId)}`;
  }

  /** True when Recall connects with a token we issued. */
  isValidToken(token: string): boolean {
    return this.tokens.has(token);
  }

  botIdForToken(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }

  addClient(botId: string, sock: RelaySocket): () => void {
    let set = this.clients.get(botId);
    if (!set) {
      set = new Set();
      this.clients.set(botId, set);
    }
    set.add(sock);
    const buffered = this.pending.get(botId);
    if (buffered) {
      for (const m of buffered) sock.send(m);
      this.pending.delete(botId);
    }
    return () => {
      set!.delete(sock);
    };
  }

  /** Incoming message from Recall for `token`; wraps and fans out. Returns number of receivers. */
  onRecallMessage(token: string, raw: string): number {
    const botId = this.botIdForToken(token);
    if (!botId) return 0;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return 0;
    }
    const wrapped = JSON.stringify({ relay: { botId, receivedAt: this.now() }, message });
    const set = this.clients.get(botId);
    if (!set || set.size === 0) {
      const buf = this.pending.get(botId) ?? [];
      // Only keep non-audio events while nobody listens (audio is useless late).
      if (!(message as { event?: string }).event?.startsWith("audio_")) {
        buf.push(wrapped);
        while (buf.length > this.maxPending) buf.shift();
        this.pending.set(botId, buf);
      }
      return 0;
    }
    for (const s of set) s.send(wrapped);
    return set.size;
  }

  /**
   * Push a message we generated (not one Recall sent) to this bot's clients. Bot status arrives by
   * webhook, and the page and the operator UI need it without asking Recall — the alternative is the
   * polling this design exists to remove.
   */
  broadcast(botId: string, message: unknown): number {
    const set = this.clients.get(botId);
    if (!set || set.size === 0) return 0;
    const wrapped = JSON.stringify({ relay: { botId, receivedAt: this.now() }, message });
    for (const s of set) s.send(wrapped);
    return set.size;
  }

  clientCount(botId: string): number {
    return this.clients.get(botId)?.size ?? 0;
  }

  /** Cleanup on leave / end / revoke: closes clients, forgets tokens and buffered messages for the bot. */
  dropBot(botId: string): void {
    const set = this.clients.get(botId);
    if (set) for (const s of set) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.delete(botId);
    this.pending.delete(botId);
    for (const [tok, b] of this.tokens) if (b === botId) this.tokens.delete(tok);
  }
}
