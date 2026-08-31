import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultDataDir } from "./store.js";

/**
 * Durable webhook job queue. The webhook route must verify, enqueue and return 2xx well inside
 * Recall's 15 s timeout, so every side effect happens here instead of in the request.
 *
 * Idempotency is keyed on the Recall `webhook-id`: Svix retries the same id, so a job whose id is
 * already in the processed set is dropped before any side effect.
 */

export interface Job {
  id: string;
  /** Recall webhook-id — the idempotency key. */
  webhookId: string;
  event: string;
  payload: unknown;
  attempts: number;
  enqueuedAt: string;
  nextAttemptAt: number;
  lastError?: string;
}

export type JobHandler = (job: Job) => Promise<void>;

export interface QueueOptions {
  dir?: string;
  maxAttempts?: number;
  /** Backoff for a failed job (ms). */
  backoff?: (attempt: number) => number;
  now?: () => number;
}

export class WebhookQueue {
  private readonly dir: string;
  private readonly deadDir: string;
  private readonly processedFile: string;
  private readonly processed = new Set<string>();
  private readonly maxAttempts: number;
  private readonly backoff: (attempt: number) => number;
  private readonly now: () => number;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: QueueOptions = {}) {
    const root = opts.dir ?? join(defaultDataDir(), "queue");
    this.dir = join(root, "pending");
    this.deadDir = join(root, "dead");
    this.processedFile = join(root, "processed.json");
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.deadDir, { recursive: true });
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoff = opts.backoff ?? ((a) => Math.min(2 ** a * 1000, 60_000));
    this.now = opts.now ?? Date.now;
    try {
      for (const id of JSON.parse(readFileSync(this.processedFile, "utf8")) as string[]) this.processed.add(id);
    } catch {
      /* first run */
    }
  }

  /** True when this webhook-id has already been handled (Svix retry / replay). */
  seen(webhookId: string): boolean {
    return this.processed.has(webhookId);
  }

  get pendingCount(): number {
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).length;
  }

  get deadCount(): number {
    return readdirSync(this.deadDir).filter((f) => f.endsWith(".json")).length;
  }

  private write(dir: string, job: Job): void {
    const file = join(dir, `${job.id}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(job, null, 2));
    renameSync(tmp, file);
  }

  private markProcessed(webhookId: string): void {
    this.processed.add(webhookId);
    // Bound the set so the file cannot grow without limit; Svix retries live for ~24 h.
    const ids = [...this.processed].slice(-5000);
    this.processed.clear();
    for (const id of ids) this.processed.add(id);
    const tmp = `${this.processedFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(ids));
    renameSync(tmp, this.processedFile);
  }

  /** Returns false when the webhook-id was already processed (idempotent no-op). */
  enqueue(webhookId: string, event: string, payload: unknown): boolean {
    if (this.seen(webhookId)) return false;
    const job: Job = {
      id: `job_${randomUUID()}`,
      webhookId,
      event,
      payload,
      attempts: 0,
      enqueuedAt: new Date(this.now()).toISOString(),
      nextAttemptAt: this.now(),
    };
    this.write(this.dir, job);
    return true;
  }

  private load(): Job[] {
    const jobs: Job[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      try {
        jobs.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Job);
      } catch {
        /* ignore a torn file */
      }
    }
    return jobs.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
  }

  /** Run every job that is due. Returns how many succeeded. */
  async drain(handler: JobHandler): Promise<number> {
    let ok = 0;
    for (const job of this.load()) {
      if (job.nextAttemptAt > this.now()) continue;
      if (this.seen(job.webhookId)) {
        rmSync(join(this.dir, `${job.id}.json`), { force: true });
        continue;
      }
      try {
        await handler(job);
        this.markProcessed(job.webhookId);
        rmSync(join(this.dir, `${job.id}.json`), { force: true });
        ok++;
      } catch (e) {
        const attempts = job.attempts + 1;
        const next: Job = { ...job, attempts, lastError: String((e as Error).message).slice(0, 200), nextAttemptAt: this.now() + this.backoff(attempts) };
        if (attempts >= this.maxAttempts) {
          this.write(this.deadDir, next);
          rmSync(join(this.dir, `${job.id}.json`), { force: true });
        } else {
          this.write(this.dir, next);
        }
      }
    }
    return ok;
  }

  /** Background worker; safe to call twice. */
  start(handler: JobHandler, intervalMs = 500): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.drain(handler);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
