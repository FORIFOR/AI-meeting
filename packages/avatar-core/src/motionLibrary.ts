import type { MotionClip } from "./motion.js";
import type { MotionCategory } from "./types.js";

export interface PickContext {
  /** 0..1 desired energy */
  energy?: number;
  tags?: string[];
  rng?: () => number;
  /** Explicitly exclude ids (in addition to history). */
  exclude?: string[];
}

/**
 * Spec §12: registry + no-repeat selection with a 3–5 item history.
 */
export class MotionLibrary {
  private clips = new Map<string, MotionClip>();
  private history: string[] = [];

  constructor(readonly historySize = 5) {}

  register(clip: MotionClip): this {
    this.clips.set(clip.id, clip);
    return this;
  }

  registerAll(clips: MotionClip[]): this {
    for (const c of clips) this.register(c);
    return this;
  }

  get(id: string): MotionClip | undefined {
    return this.clips.get(id);
  }

  has(id: string): boolean {
    return this.clips.has(id);
  }

  ids(): string[] {
    return [...this.clips.keys()];
  }

  byCategory(category: MotionCategory): MotionClip[] {
    return [...this.clips.values()].filter((c) => c.category === category);
  }

  getHistory(): string[] {
    return [...this.history];
  }

  /** Records that a clip was played (external callers may play by id). */
  notePlayed(id: string): void {
    this.history.push(id);
    while (this.history.length > this.historySize) this.history.shift();
  }

  /** Pick a clip by category avoiding the recent history (unless nothing else exists). */
  pick(category: MotionCategory, ctx: PickContext = {}): MotionClip | null {
    const rng = ctx.rng ?? Math.random;
    let candidates = this.byCategory(category);
    if (ctx.tags?.length) {
      const tagged = candidates.filter((c) => ctx.tags!.some((t) => c.tags?.includes(t)));
      if (tagged.length) candidates = tagged;
    }
    if (ctx.exclude?.length) candidates = candidates.filter((c) => !ctx.exclude!.includes(c.id));
    if (candidates.length === 0) return null;
    const fresh = candidates.filter((c) => !this.history.includes(c.id));
    const pool = fresh.length ? fresh : candidates.filter((c) => c.id !== this.history[this.history.length - 1]);
    const finalPool = pool.length ? pool : candidates;
    // Weight by closeness to desired energy.
    const weights = finalPool.map((c) => {
      if (ctx.energy === undefined || c.energy === undefined) return 1;
      return 0.2 + 1 - Math.min(1, Math.abs(c.energy - ctx.energy));
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    let chosen = finalPool[finalPool.length - 1]!;
    for (let i = 0; i < finalPool.length; i++) {
      r -= weights[i]!;
      if (r <= 0) {
        chosen = finalPool[i]!;
        break;
      }
    }
    this.notePlayed(chosen.id);
    return chosen;
  }
}
