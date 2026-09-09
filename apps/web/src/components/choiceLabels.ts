/** Friendly labels only; provider and persona identifiers stay unchanged. */
export function purposeLabel(name: string): string {
  return ({
    "English: Free Talk": "自由に話す", "English: Travel": "旅行の英会話",
    "English: Business": "仕事の英会話", "English: Job Interview": "英語の面接",
    "English: Daily Conversation": "日常会話", "English: Pronunciation": "発音の練習",
    "English: Beginner": "はじめての英会話", "Interviewer (English)": "面接官（英語）",
  } as Record<string, string>)[name] ?? name;
}
export function optionLabel(value: string): string {
  return ({ beginner: "初心者", intermediate: "中級者", advanced: "上級者" } as Record<string, string>)[value] ?? value;
}
