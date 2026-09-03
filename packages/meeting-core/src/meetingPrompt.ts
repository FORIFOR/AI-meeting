/**
 * What the character is told about being in a meeting — the session instructions appended to the
 * persona, and the per-turn text handed to the model when the room addresses it. Pure text, shared by
 * the meeting session (apps/web) and the offline conversation gate (scripts/reality/conversation-eval),
 * so the wording that is measured is the wording that ships.
 */

export interface MeetingInstructionsInput {
  /** The name the character joined under — what the room calls it. */
  displayName: string;
  /** True when the character may join in unasked (any proactivity other than `addressed_only`). */
  proactive: boolean;
}

/**
 * The visual half of the instructions matters as much as the conversational half: a model handed
 * face measurements will otherwise narrate them back as psychology — 「不安そうですね」 — to a real
 * person in a real meeting. Cues are uncertain observations that may earn a reply, never a
 * diagnosis, and never something to say out loud.
 */
export function meetingInstructions({ displayName, proactive }: MeetingInstructionsInput): string {
  return (
    `あなたはオンライン会議に参加している「${displayName}」です。簡潔に（1〜2文で）答えます。` +
    (proactive ? "会話に自然に参加しますが、人が話している間は割り込みません。" : "会議の参加者に名前で呼ばれたときだけ答え、呼ばれていない間は発言しません。") +
    "一度話しかけられたら、その相手との会話が続く間は名前で呼ばれなくても応じます。" +
    // Asked 「今日の予定を教えて」, the model produced a day's schedule the character does not have
    // (conversation gate, meeting-standup baseline: 「午後からミーティングがいくつか入ってるよ」). A
    // colleague who does not know says so; one who has been listening answers from the room.
    "答えの材料は、この会議で聞いたことと自分の考えだけです。自分の予定・数字・出来事など知らないことは作らず、知らないと言うか、その場で聞き返してください。" +
    "短くても中身を入れる：意見には理由を一言添え、まとめでは決まったこと（日付・担当・理由）を具体的に言う。" +
    // The recogniser writes the name as it hears it — 「ゆイ」「うい」 — and the model repeated that
    // spelling back to the room (Gate #8 run 15: 「ゆイ、お疲れ様！」). Answers do not begin with the
    // name at all; the room already knows who is talking.
    "発言は音声認識の書き起こしなので、あなたの名前が「ゆイ」「うい」のように別の表記になっていることがあります。それは呼びかけの聞き間違いです。返答であなた自身の名前や、相手が使った表記を繰り返さないでください。" +
    "カメラから得た情報（うなずき・首振り・表情・視線）は不確実な観測です。相手の感情や心理状態を断定しない（「不安そう」「怒っている」などと言わない）。" +
    "うなずきや首振りは、言葉がなくても返事として扱ってよい。"
  );
}

export interface MeetingTurnInput {
  /** The room's recent lines before the one that addressed the character, oldest first, as "speaker: text". */
  context: string[];
  /** The rendered visual observations, if any (see MeetingSessionController.visualContext). */
  seen?: string;
  /** The line that addressed the character; a reaction with no words carries the detection reason instead. */
  asked: { speakerName?: string | null; text: string } | { reaction: string };
}

/** The text sent for one turn in which the room addressed the character. */
export function meetingTurnPrompt({ context, seen, asked }: MeetingTurnInput): string {
  const line = "text" in asked ? `【あなたへの質問】${asked.speakerName ?? "参加者"}: ${asked.text}` : `【言葉のない反応】${asked.reaction}`;
  const ctx = context.join("\n");
  return `${ctx ? `【会議の直近の発言】\n${ctx}\n\n` : ""}${seen ? `${seen}\n\n` : ""}${line}\n\n短く（1〜2文で）答えてください。`;
}

/**
 * Arrival is the one turn with nothing to answer. The greeting is the character's, not a fixed
 * line: it should sound like the persona and say the one thing the room needs to know — how to
 * get its attention — without a speech.
 */
export function meetingGreetingPrompt(displayName: string): string {
  return `【入室】たった今この会議に参加しました。一言だけ挨拶してください：名前を名乗り、「${displayName}」と呼びかければ答えると伝える。自己紹介以上のことは話さない。\n\n短く（1〜2文で）。`;
}
