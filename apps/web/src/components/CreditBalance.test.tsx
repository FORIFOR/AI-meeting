// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { CreditBalance } from "./CreditBalance.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("shows the remaining wallet without exposing provider costs", async () => {
  const d = JSON.parse(readFileSync("apps/web/public/meeting-credit-usage.json", "utf8"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(d))));
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(<CreditBalance/>));
    expect(host.textContent).toContain("95.47"); expect(host.textContent).toContain("初期付与 100.00");
    expect(host.textContent).toContain("残りのクレジット");
    expect(host.textContent).not.toContain("$"); expect(host.textContent).not.toContain("Google Cloud");
    expect(host.textContent).not.toContain("請求");
  } finally { await act(async()=>root.unmount());vi.unstubAllGlobals(); }
});
it("does not substitute zero for an unavailable ledger", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const host = document.createElement("div"), root = createRoot(host);
  try { await act(async () => root.render(<CreditBalance/>)); expect(host.textContent).toContain("100.00"); expect(host.textContent).toContain("取得できませんでした"); }
  finally { await act(async()=>root.unmount());vi.unstubAllGlobals(); }
});
