import { describe, expect, it } from "vitest";
import { canonicalizeName, meetingGreetingPrompt, meetingInstructions, meetingTurnPrompt } from "./meetingPrompt.js";

describe("meeting prompt text", () => {
  it("tells an addressed-only character when to speak, and never to invent what it does not know", () => {
    const text = meetingInstructions({ displayName: "Yui", proactive: false });
    expect(text).toContain("「Yui」");
    expect(text).toContain("名前で呼ばれたときだけ答え");
    expect(text).not.toContain("会話に自然に参加");
    expect(text).toContain("知らないことは作らない");
    expect(text).toContain("「〜のこと？」と確認し");
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

  it("restates the demonstrative rule on the turn that needs it, and only then", () => {
    const ask = (text: string) => meetingTurnPrompt({ context: [], asked: { speakerName: "Tester", text } });
    expect(ask("ゆい、これはどう思う？")).toContain("「これ」「それ」が何を指すか曖昧です");
    expect(ask("ゆい、それどう？")).toContain("何を指すか曖昧です");
    expect(ask("ゆい、その件はどうする？")).toContain("何を指すか曖昧です");
    // これから / それで are not referents; a plain question carries no hint at all
    expect(ask("ゆい、これから始めるよ")).not.toContain("曖昧");
    expect(ask("ゆい、それでいいよ")).not.toContain("曖昧");
    expect(ask("ゆい、今日の予定を教えて。")).not.toContain("曖昧");
    expect(meetingTurnPrompt({ context: [], asked: { reaction: "nod" } })).not.toContain("曖昧");
  });

  it("asks for a greeting that says how to get the character's attention", () => {
    expect(meetingGreetingPrompt("Yui")).toContain("「Yui」と声をかけてもらえれば返事をする");
    expect(meetingGreetingPrompt("Yui")).toContain("自分の名前「Yui」を名乗る");
  });
});

describe("canonicalizeName", () => {
  const names = ["Yui", "ゆい", "ユイ", "結衣"];
  it("rewrites every spelling the recognisers use to the name the model knows, kana in either script", () => {
    expect(canonicalizeName("結衣が昨日そう言ってたよね", "Yui", names)).toBe("Yuiが昨日そう言ってたよね");
    expect(canonicalizeName("ゆイ、今どう思う？", "Yui", names)).toBe("Yui、今どう思う？");
    expect(canonicalizeName("ユイとゆいと結衣", "Yui", names)).toBe("YuiとYuiとYui");
    expect(canonicalizeName("yui、聞こえる？", "Yui", names)).toBe("Yui、聞こえる？");
  });
  it("leaves everything else alone", () => {
    expect(canonicalizeName("昨日の資料、見てくれた?", "Yui", names)).toBe("昨日の資料、見てくれた?");
    expect(canonicalizeName("結衣が言ってた", "Yui", [])).toBe("結衣が言ってた");
    expect(canonicalizeName("結衣", "", [])).toBe("結衣");
  });
});
