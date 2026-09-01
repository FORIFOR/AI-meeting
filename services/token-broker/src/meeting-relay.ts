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

  private readonly vendors = new Map<string, RelaySocket>();
  /** Counters, so "the socket connected but nothing arrived" is answerable without a rerun. */
  private readonly received = new Map<string, number>();
  private readonly malformed = new Map<string, number>();

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
      // A vendor that sends binary or non-JSON would otherwise vanish here without a trace.
      this.malformed.set(botId, (this.malformed.get(botId) ?? 0) + 1);
      return 0;
    }
    this.received.set(botId, (this.received.get(botId) ?? 0) + 1);
    const wrapped = JSON.stringify({ relay: { botId, receivedAt: this.now() }, message });
    const set = this.clients.get(botId);
    if (!set || set.size === 0) {
      const buf = this.pending.get(botId) ?? [];
      // Only keep events that are still worth something late: audio and video frames are not.
      const m = message as { event?: string; trigger?: string };
      const perishable = m.event?.startsWith("audio_") || m.trigger?.startsWith("realtime_audio.") || m.trigger?.startsWith("realtime_video.");
      if (!perishable) {
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
   * The vendor's own socket, so a client can talk back to it.
   *
   * Recall's realtime endpoint only ever sends; Attendee's is bidirectional — the character's audio goes
   * back the same way it arrives. Keeping the socket here is what makes one relay serve both.
   */
  setVendor(botId: string, sock: RelaySocket | null): void {
    if (sock) this.vendors.set(botId, sock);
    else this.vendors.delete(botId);
  }

  sendToVendor(botId: string, raw: string): boolean {
    const v = this.vendors.get(botId);
    if (!v) return false;
    v.send(raw);
    return true;
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

  /** What this bot's relay has actually seen: forwarded, unparseable, and who is listening. */
  stats(botId: string): { received: number; malformed: number; clients: number; vendor: boolean } {
    return {
      received: this.received.get(botId) ?? 0,
      malformed: this.malformed.get(botId) ?? 0,
      clients: this.clients.get(botId)?.size ?? 0,
      vendor: this.vendors.has(botId),
    };
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
    this.vendors.delete(botId);
    for (const [tok, b] of this.tokens) if (b === botId) this.tokens.delete(tok);
  }
}
