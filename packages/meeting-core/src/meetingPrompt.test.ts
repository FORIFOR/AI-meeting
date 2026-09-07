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
    expect(text).toBe("【会議の直近の発言】\nTester: 3ページ目の数字が気になる。\nTester: 後で直すね。\n\n【見えていること】うなずき\n\n【あなたへの質問】Tester: ゆいはどう思う？\n\n【会議の直近の発言】は状況を知るためのものです。答えるのは【あなたへの質問】だけで、「ちょっと待って」のようにあなたに黙るよう求めた発言について、あとから意見や感想を述べないでください。\n\n短く（1〜2文で）答えてください。");
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

  it("tells the model the recent lines are bearings, and an interruption is not a topic (run 110)", () => {
    const withContext = meetingTurnPrompt({ context: ["?: ちょっと待って、その前にこっちの話先にさせて", "?: ゆい、今どう思う?"], seen: "", asked: { text: "ゆい、今どう思う？", speakerName: "Tester" } });
    expect(withContext).toContain("あなたに黙るよう求めた発言について、あとから意見や感想を述べないでください");
    const without = meetingTurnPrompt({ context: [], seen: "", asked: { text: "ゆい、今どう思う？", speakerName: "Tester" } });
    expect(without).not.toContain("黙るよう求めた");
  });

  it("has no news, weather or clock of its own — and states the clock only when the page hands it over", () => {
    expect(meetingInstructions({ displayName: "Yui", proactive: false })).toContain("リアルタイム情報やインターネット検索は使えない");
    const withClock = meetingTurnPrompt({ context: [], seen: "", now: "2026-09-07 02:05", asked: { text: "ゆい、今何時？", speakerName: "Tester" } });
    expect(withClock).toContain("【現在時刻】2026-09-07 02:05");
    const without = meetingTurnPrompt({ context: [], seen: "", asked: { text: "ゆい、今何時？", speakerName: "Tester" } });
    expect(without).not.toContain("【現在時刻】");
  });
});

/**
 * The ordinary case is one person talking with the character, and the meeting rules are written
 * around a meeting's material. Given them with none of it present, the character invented it: it
 * opened with the state of a document nobody had shared (「資料の共有をしていないのに共有されている
 * 資料の話をしてきます」, real one-to-one run, 2026-09-07).
 */
describe("one to one is not a meeting", () => {
  const oneToOne = meetingInstructions({ displayName: "Yui", proactive: true, aliases: ["ゆい"], setting: "one_to_one" });

  it("says it is not a meeting, and forbids talk of material nobody shared", () => {
    expect(oneToOne).toContain("1対1");
    expect(oneToOne).toContain("会議ではありません");
    expect(oneToOne).toContain("見ていないものを見たことにしない");
    expect(oneToOne).toContain("相手が出していない資料・会議・議事録の話を自分から始めない");
    // None of the meeting's own furniture is described to it.
    expect(oneToOne).not.toContain("オンライン会議に参加している");
    expect(oneToOne).not.toContain("この会議で聞いたこと");
  });

  it("keeps the rules that are about the person, not the room", () => {
    expect(oneToOne).toContain("リアルタイム情報やインターネット検索は使えない");
    expect(oneToOne).toContain("うなずきや首振り");
    expect(oneToOne).toContain("「〇〇さん」のような伏せ字は絶対に言わない");
    expect(oneToOne).toContain("別の表記になっていることがある");
  });

  it("a meeting still gets the meeting's instructions", () => {
    const meeting = meetingInstructions({ displayName: "Yui", proactive: false, aliases: ["ゆい"] });
    expect(meeting).toContain("オンライン会議に参加している");
    expect(meeting).not.toContain("会議ではありません");
  });

  it("the turn prompt drops the meeting's headings too", () => {
    const turn = meetingTurnPrompt({ context: ["相手: 昨日は疲れたよ"], asked: { speakerName: "相手", text: "これどう思う？" }, setting: "one_to_one" });
    expect(turn).toContain("【直前のやりとり】");
    expect(turn).not.toContain("【会議の直近の発言】");
    expect(turn).toContain("まだ何も出ていなければ"); // the demonstrative hint, without a meeting's documents
    expect(meetingTurnPrompt({ context: ["A: x"], asked: { speakerName: "A", text: "これどう思う？" } })).toContain("【会議の直近の発言】");
  });
});

/**
 * 「ニュースを教えてくれません」, said twice on 2026-09-07. The rule was right for a model that cannot
 * look anything up and wrong for one that can: the provider says which it is.
 */
describe("what it may say about today", () => {
  it("is told to look it up when the provider can", () => {
    const canSearch = meetingInstructions({ displayName: "Yui", proactive: true, canSearch: true, setting: "one_to_one" });
    expect(canSearch).toContain("検索して答えてよい");
    expect(canSearch).toContain("憶測で数字や日付を作らない");
    expect(canSearch).not.toContain("インターネット検索は使えない");
  });

  it("is told it cannot when the provider cannot", () => {
    for (const setting of ["one_to_one", "meeting"] as const) {
      const cannot = meetingInstructions({ displayName: "Yui", proactive: true, setting });
      expect(cannot).toContain("インターネット検索は使えない");
      expect(cannot).not.toContain("検索して答えてよい");
    }
  });
})

describe("being misheard is worse than asking", () => {
  it("tells both settings to ask back for the part it lost, not to fill it in", () => {
    for (const setting of ["one_to_one", "meeting"] as const) {
      const t = meetingInstructions({ displayName: "Yui", proactive: true, setting });
      expect(t).toContain("聞き取れなかったところは推測で埋めない");
      expect(t).toContain("その部分だけを短く聞き返す");
    }
  });
});

/**
 * A provider that decides its own turns never sees the per-turn prompt, so the instructions are the
 * only place it learns what day it is. Without it 「来週の水曜」 came back as a date three weeks out,
 * stated with confidence (one-to-one script, 07 Sep).
 */
describe("what day it is", () => {
  it("is in the instructions when the page knows it, in both settings", () => {
    for (const setting of ["one_to_one", "meeting"] as const) {
      const t = meetingInstructions({ displayName: "Yui", proactive: true, setting, now: "2026-09-07 21:05" });
      expect(t).toContain("【2026-09-07 21:05】");
      expect(t).toContain("日付の計算");
    }
  });

  it("is left out rather than guessed at when it is not known", () => {
    const t = meetingInstructions({ displayName: "Yui", proactive: true, setting: "one_to_one" });
    expect(t).not.toContain("日付の計算");
  });
});
