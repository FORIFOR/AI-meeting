import type { ConversationTask } from '@rcai/conversation-core';
import '../styles/task-overview.css';

type Props = {
  tasks: readonly Pick<ConversationTask, 'status'>[];
  ready: boolean;
  busy: boolean;
  onTalk?: () => void;
  voiceHint?: string;
};

/** Counts come only from the last successfully read workspace, never a demo. */
export function TaskOverview({ tasks, ready, busy, onTalk, voiceHint }: Props) {
  const counts = tasks.reduce((result, task) => {
    result[task.status] += 1;
    return result;
  }, { pending: 0, deferred: 0, done: 0 });
  const states = [
    ['pending', '未完了'], ['deferred', '延期'], ['done', '完了'],
  ] as const;
  return <section className="task-overview" aria-labelledby="task-overview-title" aria-busy={!ready}>
    <div className="task-overview__saved">
      <p className="task-overview__eyebrow">SAVED WORKSPACE</p>
      <h2 id="task-overview-title">次に取り組むこと</h2>
      <p className="task-overview__note">{ready ? '最後に読み込んだ、保存済みのタスクです。' : '保存したタスクを読み込んでいます。'}</p>
      <dl className="task-overview__counts">
        {states.map(([state, text]) => <div key={state} data-task-state={state}>
          <dt>{text}</dt><dd>{ready ? counts[state] : '—'}<span>{ready ? '件' : ''}</span></dd>
        </div>)}
      </dl>
    </div>
    <div className="task-overview__voice">
      <p className="task-overview__eyebrow">NEXT ACTION</p>
      <h3>声で、次の一歩を整理する。</h3>
      <p>{voiceHint ?? '保存したタスクを引き継いで話せます。'}</p>
      <button className="btn btn--primary" type="button" onClick={onTalk} disabled={!onTalk || !ready || busy}>声でタスクを整理する ↗</button>
      {!onTalk && <small>この画面では音声を開始できません。下の欄からタスクを追加・編集できます。</small>}
    </div>
  </section>;
}
