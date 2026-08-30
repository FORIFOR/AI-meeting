/** Tiny async queue used between producers (LLM / TTS daemon) and consumers. */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: T | null) => void)[] = [];
  private closed = false;

  get size(): number {
    return this.items.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w(item);
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
  }

  /** Next item, or null once closed and drained. */
  next(): Promise<T | null> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const v = await this.next();
      if (v === null) return;
      yield v;
    }
  }
}
