/**
 * Builds the endpointing corpus WAVs (16 kHz mono PCM16) with macOS `say -v Kyoko`.
 * Multi-clause items are joined with `pauseMs` of digital silence. Ground truth = last audible sample.
 * Usage: pnpm --filter @rcai/agent exec tsx ../../tools/endpointing-corpus/build.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(here, "corpus.json"), "utf8")) as { items: { id: string; tag: string; clauses: string[]; pauseMs?: number }[] };
const outDir = path.join(here, "wav");
fs.mkdirSync(outDir, { recursive: true });

function sayPcm(text: string, voice: string): Int16Array {
  const tmp = path.join(outDir, `_tmp_${process.pid}.wav`);
  execFileSync("say", ["-v", voice, "--data-format=LEI16@16000", "-o", tmp, text]);
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  // minimal RIFF parse: find "data" chunk
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return new Int16Array(buf.buffer.slice(buf.byteOffset + off + 8, buf.byteOffset + off + 8 + size));
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

function trimTrailingSilence(pcm: Int16Array, thresh = 300): Int16Array {
  let end = pcm.length;
  while (end > 0 && Math.abs(pcm[end - 1]!) < thresh) end--;
  return pcm.subarray(0, end + 800); // keep 50 ms natural tail
}

function writeWav(file: string, pcm: Int16Array): void {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length * 2, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]));
}

const manifest: { id: string; tag: string; text: string; file: string; pauseMs: number; clauseEndsMs: number[]; groundTruthEndMs: number }[] = [];
for (const item of corpus.items) {
  const voice = /[A-Za-z]/.test(item.clauses.join("")) && !/[぀-ヿ一-鿿]/.test(item.clauses.join("")) ? "Samantha" : "Kyoko";
  const parts: Int16Array[] = [];
  const clauseEnds: number[] = [];
  let total = 0;
  item.clauses.forEach((c, i) => {
    const pcm = trimTrailingSilence(sayPcm(c, voice));
    parts.push(pcm);
    total += pcm.length;
    clauseEnds.push(Math.round((total / 16000) * 1000));
    if (i < item.clauses.length - 1) {
      const sil = new Int16Array(Math.round(((item.pauseMs ?? 450) / 1000) * 16000));
      parts.push(sil);
      total += sil.length;
    }
  });
  const merged = new Int16Array(total);
  let o = 0;
  for (const p of parts) { merged.set(p, o); o += p.length; }
  // ground truth: last sample above threshold
  let gt = merged.length;
  while (gt > 0 && Math.abs(merged[gt - 1]!) < 300) gt--;
  const file = path.join(outDir, `${item.id}.wav`);
  writeWav(file, merged);
  manifest.push({ id: item.id, tag: item.tag, text: item.clauses.join(" "), file, pauseMs: item.pauseMs ?? 0, clauseEndsMs: clauseEnds, groundTruthEndMs: Math.round((gt / 16000) * 1000) });
}
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`built ${manifest.length} items → ${outDir}`);
