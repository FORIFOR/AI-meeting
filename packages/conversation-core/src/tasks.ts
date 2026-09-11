/** Session-local task state. Only explicitly quoted user statements may change it. */
export interface ConversationTask { id: string; title: string; due?: string; status: 'pending' | 'done' | 'deferred'; }
export interface TaskProposal { id: string; changes: ConversationTask[]; }
export const TASK_TOOL = {
  name: 'session_tasks',
  description: 'ユーザーが明示したタスクを記録・更新・一覧確認する。推測で追加せず、quoteには今回のユーザー発話の原文を入れる。完了・延期しても他のタスクを消さない。一覧だけならoperationsを空にする。',
  parameters: { type: 'object', properties: { operations: { type: 'array', items: { type: 'object', properties: {
    action: { type: 'string', enum: ['add','update'] }, id: { type: 'string', description: 'updateでは必須。ツールが返した既存タスクのidを使う。不明なら先にoperations=[]で一覧を読む。' },
    title: { type: 'string', description: 'addだけで指定する行動。quote内の連続した原文を使い、言い換えない。updateでは送らない。' },
    due: { type: 'string', description: '明示された期限の原文。dueの文字列自体をquoteにも含める。推測・日時変換をしない。延期先が明示されたupdateは新しいdueも必ず送る。変更しない期限はupdateで送らない。' },
    status: { type: 'string', enum: ['pending','done','deferred'] },
    quote: { type: 'string', description: '今回のユーザー発話からの連続した原文引用。titleだけでなく、dueを送るならその期限も含む範囲を引用する。複数文を含めてよい。' },
  }, required: ['action','quote'] } } }, required: ['operations'] },
};
export const TASK_INSTRUCTIONS = '\nタスク整理にはsession_tasksツールを使う。タスクや状態の変更を聞いたら、返答前に原文引用を添えて記録する。記録は追加・更新のみで、前提作業の追加は元のタスクを置き換えない。\n引数の規則: addのtitleは原文どおり。dueを指定する場合、quoteは行動名と期限の両方を含む連続した原文にする。行動名だけのquoteに、別の箇所で聞いたdueを付けると拒否される。複数文で期限を話した場合は、その複数文全体を引用してよい。updateは返された既存idを必ず指定し、titleは送らない。idが不明ならoperations=[]で一覧を読んでから更新する。\n残件や期限の要約・次の一歩を求められたら、まずoperations=[]で最新の記録を読み、pendingの行動とdueを省かず答える。既に記録された期限を聞き直さない。記録にない行動・期限を作らない。ツールの結果を待ってから変更の成功を伝える。\n形式エラーの扱い: due must be quoted, not inferredなら、発話に明示された期限も含むquoteへ直す。title must be quotedなら原文の行動名に戻す。unknown task idなら一覧を読み、実在するidで更新する。updates must preserve the task titleならupdateからtitleを除く。根拠が既にある形式エラーはユーザーに同じ内容を言わせず、自分の引数を修正して一度だけ再試行する。推測で根拠を補わない。needs_user_confirmationなら未反映なので画面での確認を案内し、完了・記録済みとは言わない。同じ変更を再送しない。';
const normalized = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");
export class TaskLedger {
  private tasks: ConversationTask[] = [];
  private proposals = new Map<string, { args: Record<string,unknown>; source: string; before: ConversationTask[]; changes: ConversationTask[] }>();
  private proposalSeq = 0;
  pending(): TaskProposal[] { return [...this.proposals].map(([id,p])=>({id,changes:p.changes.map(t=>({...t}))})); }
  propose(args: Record<string,unknown>): { proposal?: TaskProposal; error?: string } {
    if (!Array.isArray(args.operations)) return {error:'invalid operations'};
    const source=args.operations.map(op=>typeof op?.quote==='string'?op.quote:'').join('\n');
    const preview=new TaskLedger(); preview.tasks=this.snapshot();
    const result=preview.apply(args,source);
    if(result.error)return {error:result.error};
    const changes=result.tasks.filter(t=>JSON.stringify(t)!==JSON.stringify(this.tasks.find(old=>old.id===t.id)));
    if(!changes.length)return {error:'no changes'};
    for(const [id,p] of this.proposals)if(JSON.stringify(p.changes)===JSON.stringify(changes))return {proposal:{id,changes}};
    if(this.proposals.size>=5)return {error:'review pending changes first'};
    const id=`proposal-${++this.proposalSeq}`;
    this.proposals.set(id,{args:structuredClone(args),source,before:this.snapshot(),changes});
    return {proposal:{id,changes}};
  }
  resolve(id:string,accept:boolean): {tasks:ConversationTask[];error?:string} {
    const p=this.proposals.get(id);this.proposals.delete(id);
    if(!p)return {tasks:this.snapshot(),error:'proposal expired'};
    if(!accept)return {tasks:this.snapshot()};
    // Never overwrite a newer change the user has already made to the same task.
    const updates=(p.args.operations as {action:string;id?:string}[]).filter(op=>op.action==='update');
    if(updates.some(op=>JSON.stringify(p.before.find(t=>t.id===op.id))!==JSON.stringify(this.tasks.find(t=>t.id===op.id))))return {tasks:this.snapshot(),error:'task changed; please request the update again'};
    return this.apply(p.args,p.source);
  }
  snapshot(): ConversationTask[] { return this.tasks.map(t=>({...t})); }
  apply(args: Record<string, unknown>, latestUserText: string): { tasks: ConversationTask[]; error?: string } {
    const fail=(error:string)=>({tasks:this.snapshot(),error});
    if (!Array.isArray(args.operations) || args.operations.length>10) return fail('operations must contain at most 10 changes');
    const next=this.snapshot();
    for(const raw of args.operations) {
      if(!raw || typeof raw!=='object') return fail('invalid operation');
      const op=raw as Record<string,unknown>,quote=op.quote;
      if(typeof quote!=='string'||!quote.trim()||!normalized(latestUserText).includes(normalized(quote)))return fail('quote must occur in the latest user statement');
      if(op.due!==undefined&&(typeof op.due!=='string'||!op.due.trim()||op.due.length>80||!normalized(quote).includes(normalized(op.due))))return fail('due must be quoted, not inferred');
      const status=op.status??'pending';
      if(!['pending','done','deferred'].includes(String(status)))return fail('unknown status');
      if(op.action==='add') {
        if(typeof op.title!=='string'||!op.title.trim()||op.title.length>160||!normalized(quote).includes(normalized(op.title)))return fail('title must be quoted');
        if(next.length>=100)return fail('task limit reached');
        if(next.some(t=>t.title===op.title))return fail('task already exists; update its id');
        // Retain an explicitly spoken clock deadline immediately before this action even if the
        // model omitted the optional field. Never convert relative dates or cross list separators.
        const prefix=normalized(quote).split(normalized(op.title))[0] ?? "";
        const spokenDue=prefix.match(/([0-9]{1,2}時(?:[0-9]{1,2}分)?まで(?:に)?)[^、。,.]{0,12}$/)?.[1];
        const due=op.due ? String(op.due) : spokenDue;
        next.push({id:`task-${next.length+1}`,title:op.title,status:status as ConversationTask['status'],...(due?{due}:{})});
      } else if(op.action==='update') {
        const task=next.find(t=>t.id===op.id);
        if(!task)return fail('unknown task id');
        if(op.title!==undefined)return fail('updates must preserve the task title');
        if(op.status!==undefined)task.status=status as ConversationTask['status'];
        if(op.due!==undefined)task.due=String(op.due);
      } else return fail('unknown action');
    }
    this.tasks=next;
    return {tasks:this.snapshot()};
  }
}

export const USER_CONTEXT_TOOL = {
  name: 'read_user_context',
  description: 'このセッションでユーザーが実際に話した内容を時系列で確認する。訂正・否定・希望する条件は最新の発言を優先する。',
  parameters: {type:'object',properties:{}},
};
