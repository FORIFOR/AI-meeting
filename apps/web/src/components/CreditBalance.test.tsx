// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { CreditBalance } from "./CreditBalance.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("shows actual consumption separately from unknown total payment", async () => {
  const d = JSON.parse(readFileSync("apps/web/public/meeting-credit-usage.json", "utf8"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(d))));
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(<CreditBalance/>));
    expect(host.textContent).toContain("4.53"); expect(host.textContent).toContain("2.27");
    expect(host.textContent).toContain("合計費用：追加費用が未入力のため未確定");
    expect(host.textContent).toContain("無料枠を含む"); expect(host.textContent).toContain("自動更新ではありません");
    expect(host.querySelector('input[aria-label="追加費用（USD）"]')?.getAttribute("value")).toBe("");
  } finally { await act(async()=>root.unmount());vi.unstubAllGlobals(); }
});
it("does not substitute zero for an unavailable ledger", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const host = document.createElement("div"), root = createRoot(host);
  try { await act(async () => root.render(<CreditBalance/>)); expect(host.textContent).toContain("取得できません"); expect(host.textContent).not.toContain("0.00"); }
  finally { await act(async()=>root.unmount());vi.unstubAllGlobals(); }
});
