/** Seedable RNG (mulberry32) so behaviour is reproducible in tests. */
export function createRng(seed = Date.now() >>> 0): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sample from a gamma-ish distribution (sum of k exponentials) scaled to `mean`. */
export function gammaLike(rng: () => number, mean: number, k = 3): number {
  let s = 0;
  for (let i = 0; i < k; i++) s += -Math.log(1 - rng());
  return (s / k) * mean;
}
