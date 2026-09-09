// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { it, expect } from "vitest";
import { MeetingUsageSummary } from "./MeetingUsageSummary.js";
it("shows credits prominently, distinguishes estimates, and never invents a free AI charge", () => {
  const html = renderToStaticMarkup(<MeetingUsageSummary receipt={{ credits: .5, elapsedMs: 1800000, endedAt: 1 }} />);
  expect(html).toContain('<strong>0.50</strong>'); expect(html).toContain('30分0秒');
  expect(html).toContain('概算'); expect(html).toContain('料金の具体額は表示していません'); expect(html).toContain('未取得');
  expect(html).not.toContain('$');
  const unknown = renderToStaticMarkup(<MeetingUsageSummary receipt={{ credits: null, elapsedMs: 0, endedAt: 1 }} />);
  expect(unknown).not.toContain('<strong>0.00</strong>'); expect(unknown).toContain('確認できませんでした');
});
it("moves keyboard focus to the completed receipt without taking focus again on a late AI usage update", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const receipt = { credits: .5, elapsedMs: 1800000, endedAt: 1 };
  try {
    await act(async () => root.render(<MeetingUsageSummary receipt={receipt} />));
    expect(document.activeElement).toBe(host.querySelector('section'));
    const details = host.querySelector('summary')!; details.focus();
    await act(async () => root.render(<MeetingUsageSummary receipt={receipt} aiUsage={{ pricedTurns: 1, estimatedMicroUsd: 1000 }} />));
    expect(document.activeElement).toBe(details);
    expect(host.textContent).toContain('確認できた応答：1件');
    expect(host.textContent).not.toContain('$');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
