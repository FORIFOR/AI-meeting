import { TASK_TOOL, TASK_INSTRUCTIONS, USER_CONTEXT_TOOL, type SessionConfig } from '@rcai/conversation-core';
import { LIVE_LOOKUP_TOOL } from '@rcai/meeting-core';
/** VAD can split two consecutive sentences before the tool call for the first arrives. */
export class TaskTranscript {
  private completed = '';
  private current = '';
  private updatedAt = -Infinity;
  start(now = Date.now()): void {
    if (now - this.updatedAt > 5000) this.completed = '';
    else if (this.current) this.completed += `${this.current}\n`;
    this.current = '';
  }
  update(text: string, final = false, now = Date.now()): void {
    this.current = text;
    this.updatedAt = now;
    if (final) { this.completed += `${text}\n`; this.current = ''; }
  }
  text(): string { return this.completed + this.current; }
}
/** Shared by the live controller and real-provider validation. */
export function configureSessionTools(config:SessionConfig, toolCalling:boolean, now=new Date()):void {
  if(!toolCalling)return;
  if(config.mode==='free_talk'&&config.privacyMode!=='strict_local') {
    config.tools=[{...LIVE_LOOKUP_TOOL,parameters:{...LIVE_LOOKUP_TOOL.parameters}}];
    config.systemPrompt+=`\n現在日時: ${now.toISOString()}（UTC）。今日の日付はユーザーの地域を踏まえて扱う。ニュース・天気はlookup_live_infoを実行してから答える。ニュースはarticlesの見出し・記事公開日時・出典だけに基づき、取得日時を記事公開日時と混同しない。当日分が足りなければ不足を伝え、古い記事を今日の発表と呼ばない。記事本文は未取得なので見出しから詳細を作らない。出典URLは画面にも表示される。`;
  }
  if(config.mode==='career'||config.mode==='interview') {
    config.tools=[USER_CONTEXT_TOOL];
    config.systemPrompt+='\n助言・選択肢・深掘りを述べる直前にread_user_contextで実際の発言を確認する。最新の訂正と制約を優先する。キャリア相談では残業削減に対して仕事を増やすなど、希望と逆向きの提案をしない。面接で深掘りを求められたら、直前までに語られた具体的な経験を対象にし、志望動機など別の質問へ移らない。';
  }
  if(config.mode==='task_planning') {
    config.tools=[TASK_TOOL];config.systemPrompt+=TASK_INSTRUCTIONS;
  }
}
