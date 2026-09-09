// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Meeting } from "./Meeting.js";
import { DEFAULT_SETTINGS } from "../state/settings.js";
const capture = vi.hoisted(() => ({ init: null as any }));
vi.mock("../session/MeetingSessionController.js", () => ({ MeetingSessionController: class {
  constructor(init: unknown) { capture.init = init; }
  async start() { capture.init.handlers.onStatus("joining", "bot created"); } async leave() {} stop() {} dispose() {}
} }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("shows the receipt after host end, preserves it on leave, and resets it on another meeting", async () => {
  let now=1000; const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Meeting settings={{...DEFAULT_SETTINGS, engine:"google", characterId:"yui"}} availability={{google:true,openai:false,local:false}}
      characters={[{id:"yui",name:"Yui"},{id:"haru",name:"Haru"}] as any}
      personas={[{id:"friend",name:"雑談",mode:"free_talk",language:"ja-JP"},{id:"lesson",name:"英会話",mode:"english_lesson",language:"en-US"}] as any}
      brokerMeeting={{attendee:true,recall:false,recallPublicUrl:true,recallBotPageUrl:true}} onBack={() => {}} />));
    for (const [selector,value] of [["#meeting-character","haru"],["#meeting-purpose","lesson"],["#meeting-voice","Aoede"]]) {
      await act(async () => { const el=host.querySelector(selector!) as HTMLSelectElement; el.value=value!; el.dispatchEvent(new Event("change",{bubbles:true})); });
    }
    await act(async () => {
      const el=host.querySelector('input[placeholder^="https://meet"]') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(el,"https://meet.google.com/abc-defg-hij");
      el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    const join=[...host.querySelectorAll("button")].find(b=>b.textContent==="参加する")!;
    expect(join.disabled).toBe(false);
    await act(async () => join.click());
    now=601000;
    await act(async()=>capture.init.handlers.onStatus("ended"));
    const receipt=host.querySelector('[aria-label="今回の会議の利用クレジット"]');
    expect(receipt?.textContent).toContain("0.17");
    expect(receipt?.textContent).toContain("10分0秒");
    expect(receipt?.textContent).toContain("確定額ではありません");
    now=620000;
    await act(async()=>capture.init.handlers.onStatus("left"));
    expect(receipt?.textContent).toContain("10分0秒");
    await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent==="参加する")!.click());
    expect(host.querySelector('[aria-label="今回の会議の利用クレジット"]')).toBeNull();
    now=680000;
    await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent==="退出する")!.click());
    expect(host.querySelector('[aria-label="今回の会議の利用クレジット"]')?.textContent).toContain("0.02");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); clock.mockRestore(); }
});
