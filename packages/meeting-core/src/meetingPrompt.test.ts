import { describe, expect, it } from "vitest";
import { meetingGreetingPrompt, meetingInstructions, meetingTurnPrompt } from "./meetingPrompt.js";

describe("meeting prompt text", () => {
  it("tells an addressed-only character when to speak, and never to invent what it does not know", () => {
    const text = meetingInstructions({ displayName: "Yui", proactive: false });
    expect(text).toContain("「Yui」");
    expect(text).toContain("名前で呼ばれたときだけ答え");
    expect(text).not.toContain("会話に自然に参加");
    expect(text).toContain("知らないことは作らず");
    expect(text).toContain("意見には理由を一言添え");
    expect(meetingInstructions({ displayName: "Yui", proactive: true })).toContain("会話に自然に参加");
  });

  it("renders a turn as the room's recent lines, what was seen, and the line that addressed the character", () => {
    const text = meetingTurnPrompt({ context: ["Tester: 3ページ目の数字が気になる。", "Tester: 後で直すね。"], seen: "【見えていること】うなずき", asked: { speakerName: "Tester", text: "ゆいはどう思う？" } });
    expect(text).toBe("【会議の直近の発言】\nTester: 3ページ目の数字が気になる。\nTester: 後で直すね。\n\n【見えていること】うなずき\n\n【あなたへの質問】Tester: ゆいはどう思う？\n\n短く（1〜2文で）答えてください。");
  });

  it("leaves out what is empty, names an unknown speaker 参加者, and describes a wordless reaction", () => {
    expect(meetingTurnPrompt({ context: [], asked: { speakerName: null, text: "どう？" } })).toBe("【あなたへの質問】参加者: どう？\n\n短く（1〜2文で）答えてください。");
    expect(meetingTurnPrompt({ context: [], asked: { reaction: "nod" } })).toContain("【言葉のない反応】nod");
  });

  it("asks for a greeting that says how to get the character's attention", () => {
    expect(meetingGreetingPrompt("Yui")).toContain("「Yui」と呼びかければ答える");
  });
});
