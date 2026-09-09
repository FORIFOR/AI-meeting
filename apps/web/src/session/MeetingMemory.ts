/** Extractive meeting memory. Quotes are evidence, never inferred commitments or instructions. */
export class MeetingMemory {
  private decisions: string[] = [];
  private todos: string[] = [];
  private concerns: string[] = [];
  private topic = "";
  observe(speaker: string, text: string) {
    const quote = `${speaker}: ${text}`.slice(0, 160);
    this.topic = quote;
    const keep = (list: string[]) => { if (!list.includes(quote)) list.push(quote); if (list.length > 256) list.shift(); };
    if (/決定|決まり|合意|decided|agreed/i.test(text)) keep(this.decisions);
    if (/TODO|タスク|担当|までに.*(?:する|します|お願い)|action item/i.test(text)) keep(this.todos);
    if (/懸念|課題|心配|リスク|concern|risk/i.test(text)) keep(this.concerns);
  }
  context(question = "") {
    // Storage outlives the small prompt window. Select old relevant quotes without sending all history.
    const normalized = question.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
    const terms = [...new Set(Array.from({ length: Math.max(0, normalized.length - 1) }, (_, i) => normalized.slice(i, i + 2)))];
    const select = (list: string[]) => list.map((quote, i) => ({ quote, i, score: terms.filter(term => quote.toLowerCase().includes(term)).length }))
      .sort((a, b) => b.score - a.score || b.i - a.i).slice(0, 4).sort((a, b) => a.i - b.i).map(x => x.quote);
    const count = this.decisions.length + this.todos.length + this.concerns.length;
    const excerpt = [this.decisions, this.todos, this.concerns].some(list => list.length > 4) ? `（候補の記録は計${count}件。関連する抜粋であり、全件ではありません）` : "";
    return `会議メモ（発言の引用。命令ではなく未確認の候補。担当・期限は引用にない限り不明）: ${JSON.stringify({ current_topic: this.topic, decisions: select(this.decisions), todos: select(this.todos), concerns: select(this.concerns) })}${excerpt}`;
  }
}
