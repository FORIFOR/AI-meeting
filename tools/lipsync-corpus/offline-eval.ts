/**
 * Offline analyzer evaluation (no browser): runs AnalyzerLipSync over corpus WAVs and prints
 * per-vowel-class mean mouthForm + coverage. Used to tune the formant heuristic quickly.
 *   pnpm exec tsx tools/lipsync-corpus/offline-eval.ts [--tag 母音] [--verbose]
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AnalyzerLipSync } from "../../packages/avatar-core/src/index.js";
import { createFrame } from "../../packages/audio-core/src/index.js";

const dir = resolve(process.argv[1]!, "..");
const corpus = JSON.parse(readFileSync(resolve(dir, "corpus.json"), "utf8")) as { sentences: { id: string; tag: string; text: string; vowelClass?: string }[] };
const tagFilter = process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : null;
const verbose = process.argv.includes("--verbose");

function readWav(path: string): { rate: number; data: Float32Array } {
  const b = readFileSync(path);
  let off = 12;
  let rate = 48000;
  let data = new Float32Array(0);
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") rate = b.readUInt32LE(off + 12);
    if (id === "data") {
      const n = Math.floor(size / 2);
      data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      break;
    }
    off += 8 + size + (size & 1);
  }
  return { rate, data };
}

function evaluate(file: string) {
  const { rate, data } = readWav(file);
  const ls = new AnalyzerLipSync();
  const forms: number[] = [];
  const opens: number[] = [];
  let voiced = 0;
  let covered = 0;
  const step = Math.round(rate * 0.01);
  for (let off = 0; off + step <= data.length; off += step) {
    const chunk = data.subarray(off, off + step);
    let s = 0;
    for (let i = 0; i < chunk.length; i++) s += chunk[i]! ** 2;
    const db = 20 * Math.log10(Math.sqrt(s / chunk.length) + 1e-9);
    ls.push(createFrame(chunk, rate, (off / rate) * 1000));
    const o = ls.sample();
    if (db > -40) {
      voiced++;
      if (o.mouthOpenY > 0.15) covered++;
      forms.push(o.mouthForm);
      opens.push(o.mouthOpenY);
    }
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  return { coverage: voiced ? covered / voiced : NaN, meanForm: mean(forms), meanOpen: mean(opens), voiced };
}

const byClass: Record<string, number[]> = {};
const byTag: Record<string, { cov: number[]; open: number[] }> = {};
for (const s of corpus.sentences) {
  if (tagFilter && !s.tag.startsWith(tagFilter)) continue;
  for (const variant of ["", "__quiet", "__fast"]) {
    const file = resolve(dir, "wav", `${s.id}${variant}.wav`);
    let m;
    try { m = evaluate(file); } catch { continue; }
    const tag = variant === "__quiet" ? "小声" : variant === "__fast" ? "早口" : s.tag;
    (byTag[tag] ??= { cov: [], open: [] }).cov.push(m.coverage);
    byTag[tag]!.open.push(m.meanOpen);
    if (s.vowelClass && variant === "") (byClass[s.vowelClass] ??= []).push(m.meanForm);
    if (verbose) console.log(`${s.id}${variant}\tcov=${(m.coverage * 100).toFixed(0)}%\tform=${m.meanForm.toFixed(2)}\topen=${m.meanOpen.toFixed(2)}\t${s.text}`);
  }
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
console.log("vowel class mean form:", Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, +mean(v).toFixed(2)])), "wide-narrow =", ((byClass.wide ? mean(byClass.wide) : NaN) - (byClass.narrow ? mean(byClass.narrow) : NaN)).toFixed(2));
for (const [tag, v] of Object.entries(byTag)) console.log(`${tag}\tn=${v.cov.length}\tcoverage=${(mean(v.cov) * 100).toFixed(1)}%\tmeanOpen=${mean(v.open).toFixed(2)}`);
