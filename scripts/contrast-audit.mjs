#!/usr/bin/env node
/**
 * WCAG contrast audit for the application semantic tokens (DADS foundation).
 * Resolves apps/web/src/styles/tokens.css against @digital-go-jp/design-tokens and checks
 * every pair the UI actually paints. Text pairs need 4.5:1, UI/borders 3:1.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const files = [
  resolve(ROOT, "apps/web/node_modules/@digital-go-jp/design-tokens/dist/tokens.css"),
  resolve(ROOT, "apps/web/src/styles/tokens.css"),
];
const vars = new Map();
for (const f of files) {
  for (const m of readFileSync(f, "utf8").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) vars.set(m[1], m[2].trim());
}
const resolveVar = (v, depth = 0) => {
  if (depth > 10) return v;
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(v.trim());
  return m ? resolveVar(vars.get(m[1]) ?? "", depth + 1) : v.trim();
};
function rgba(css) {
  const v = resolveVar(css);
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) { const p = m[1].split(",").map((x) => parseFloat(x)); return [p[0], p[1], p[2], p[3] ?? 1]; }
  throw new Error(`cannot parse colour: ${css} → ${v}`);
}
const flatten = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));
const lum = ([r, g, b]) => {
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (fgVar, bgVar) => {
  const bg = rgba(bgVar);
  const fg = flatten(rgba(fgVar), bg);
  const [a, b] = [lum(fg), lum(bg.slice(0, 3))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

/** [foreground, background, kind, where] */
const PAIRS = [
  ["--app-text-primary", "--app-background", "text", "body copy"],
  ["--app-text-secondary", "--app-background", "text", "secondary copy"],
  ["--app-text-tertiary", "--app-background", "text", "metadata"],
  ["--app-text-primary", "--app-surface-sunk", "text", "on sunk surface"],
  ["--app-text-link", "--app-background", "text", "links / selected labels"],
  ["--app-text-link", "--app-selected-background", "text", "selected chip"],
  ["--app-danger", "--app-background", "text", "errors"],
  ["--app-text-on-fill", "--app-action-primary", "text", "primary button"],
  ["--app-text-on-fill", "--app-action-primary-hover", "text", "primary button hover"],
  ["--app-text-on-fill", "--app-action-fill", "text", "toast"],
  ["--app-border-strong", "--app-background", "ui", "control borders"],
  ["--app-action-primary", "--app-background", "ui", "focus ring / active underline"],
  ["--app-stage-text", "--app-stage", "text", "stage: subtitle"],
  ["--app-stage-text-2", "--app-stage", "text", "stage: mode, labels"],
  ["--app-stage-accent", "--app-stage", "text", "stage: speaking state"],
  ["--app-stage-line", "--app-stage", "ui", "stage: control rings"],
  ["--app-stage-text-3", "--app-stage", "ui", "stage: dimmed marks"],
];
const MIN = { text: 4.5, ui: 3 };
let fail = 0;
console.log("| foreground | background | where | ratio | min | result |\n|---|---|---|---|---|---|");
for (const [fg, bg, kind, where] of PAIRS) {
  const r = ratio(`var(${fg})`, `var(${bg})`);
  const ok = r >= MIN[kind];
  if (!ok) fail++;
  console.log(`| ${fg} | ${bg} | ${where} | ${r.toFixed(2)}:1 | ${MIN[kind]}:1 | ${ok ? "PASS" : "FAIL"} |`);
}
console.log(`\n${PAIRS.length - fail}/${PAIRS.length} pairs pass.`);
process.exit(fail ? 1 : 0);
