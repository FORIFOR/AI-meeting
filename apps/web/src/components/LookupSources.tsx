import type { LiveLookupResult } from '@rcai/meeting-core';
export function LookupSources({result}:{result:LiveLookupResult}) {
  const noToday = result.error?.startsWith('No articles published today');
  return <details className="lookup-sources" onClick={e=>e.stopPropagation()}>
    <summary>参照した情報{noToday ? '（本日の記事なし）' : result.error ? '（取得できませんでした）' : `（${result.articles?.length ?? result.facts.length}件）`}</summary>
    <p>取得: {new Date(result.at).toLocaleString("ja-JP")}{result.articles ? ' · 記事本文は未確認' : ''}</p>
    {result.error ? <p>{noToday ? '取得した情報に本日（日本時間）公開の記事がありませんでした。' : '情報を取得できませんでした。時間をおいてお試しください。'}</p> : result.articles?.length ? <ul>{result.articles.map(a=><li key={a.url}>
      {/^(https?):\/\//.test(a.url) ? <a href={a.url} target="_blank" rel="noopener noreferrer">{a.title}</a> : <span>{a.title}</span>}
      <small>{a.source} · 記事公開: {new Date(a.publishedAt).toLocaleString("ja-JP")}</small>
    </li>)}</ul> : <ul>{result.facts.map((f,i)=><li key={i}>{f}</li>)}</ul>}
  </details>;
}
