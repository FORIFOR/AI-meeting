// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Meeting, normalizeMeetingUrlInput, resolveMeetingProvider } from "./Meeting.js";
import { DEFAULT_SETTINGS } from "../state/settings.js";
const capture = vi.hoisted(() => ({ init: null as any }));
vi.mock("../session/MeetingSessionController.js", () => ({ MeetingSessionController: class {
  constructor(init: unknown) { capture.init = init; }
  async start() {} async leave() {} stop() {} dispose() {}
} }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("starts Hosted meeting with the selected character, purpose and voice", async () => {
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
    expect(capture.init).toMatchObject({character:{id:"haru"},persona:{id:"lesson"},voiceId:"Aoede",meetingProvider:"attendee",connectorMode:"output_media"});
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("normalizes pasted links and waits for the broker before enabling join", async () => {
  expect(normalizeMeetingUrlInput("  https://meet.google.com/abc-defg-hij\n")).toBe("https://meet.google.com/abc-defg-hij");
  expect(resolveMeetingProvider(null)).toBeNull();
  expect(resolveMeetingProvider({ attendee: true, recall: false, recallPublicUrl: true, recallBotPageUrl: true })).toBe("attendee");

  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Meeting settings={{...DEFAULT_SETTINGS, engine:"google", characterId:"yui"}} availability={{google:true,openai:false,local:false}}
      characters={[{id:"yui",name:"Yui"}] as any}
      personas={[{id:"friend",name:"雑談",mode:"free_talk",language:"ja-JP"}] as any}
      brokerMeeting={null} onBack={() => {}} />));
    const join=[...host.querySelectorAll("button")].find(b=>b.textContent==="参加する")!;
    expect(join.disabled).toBe(true);
    expect(host.textContent).toContain("会議サービスを確認しています");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
