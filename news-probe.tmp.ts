import { readFileSync } from "node:fs";
import { GeminiLiveProvider } from "./providers/gemini/src/geminiLiveProvider.js";
const p = new GeminiLiveProvider({ brokerUrl: "http://localhost:8787" } as never);
let said = "";
p.onEvent((e: { type: string; [k: string]: unknown }) => {
  if (e.type === "assistant_transcript") said = e.final !== false ? (e.text as string) : said + (e.text as string);
  else if (e.type === "error") console.log("ERR", String((e.error as Error)?.message).slice(0, 200));
});
await p.connect({ language: "ja-JP", systemPrompt: "あなたはYui。日本語で1〜3文で短く答えてください。", privacyMode: "cloud", providerOptions: { autoRespond: false } } as never);
const setup = JSON.stringify((p as never as { buildSetup: (m: string, c: unknown) => unknown }).buildSetup("gemini-3.1-flash-live-preview", { language: "ja-JP", systemPrompt: "x" }));
console.log("tools in setup:", /googleSearch/.test(setup) ? "googleSearch present" : "NO SEARCH TOOL");
await p.sendText(process.argv[2] ?? "今日のニュースを教えて");
await new Promise((r) => setTimeout(r, 25000));
console.log("said:", said);
await p.disconnect(); process.exit(0);
