// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import {act,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {CalendarActions} from './CalendarActions.js';
import {CalendarActionStore} from '../state/calendarActions.js';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
async function settle(check:()=>void) { await vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,5));});check();}); }
async function fill(node:HTMLInputElement,value:string) {await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});}
it('requires actual UI approval, stores unknown results and reconciles after remount without another POST',async()=>{
 let callback:(r:any)=>void=()=>{};let remote:any;let postCount=0;
 const request=vi.fn(async(url:string,options:any={})=>{
  if(url.includes('userinfo'))return new Response(JSON.stringify({sub:'owner',email:'owner@example.test'}),{status:200});
  if(options.method==='POST'){postCount++;remote=JSON.parse(options.body);throw new Error('lost response after commit');}
  return new Response(JSON.stringify(remote),{status:200});
 });
 vi.stubGlobal('fetch',request);
 vi.stubGlobal('google',{accounts:{oauth2:{hasGrantedAllScopes:()=>true,initTokenClient:(config:any)=>{callback=config.callback;return {requestAccessToken:()=>callback({access_token:'test-ephemeral',expires_in:3600})};}}}});
 const host=document.createElement('div');document.body.append(host);let root=createRoot(host);const projectId=`p-${crypto.randomUUID()}`;
 const task={id:'task-1',title:'予算確認',status:'pending' as const,due:'明日'};
 const button=(label:string)=>[...host.querySelectorAll('button')].find(x=>x.textContent===label)!;
 const render=()=>root.render(<StrictMode><CalendarActions projectId={projectId} task={task} privacyMode="default" clientId="public-client-id"/></StrictMode>);
 const connect=async()=>{await act(async()=>button('送信先を確認して接続を準備').click());await settle(()=>expect(button('Googleアカウントを選択')?.disabled).toBe(false));await act(async()=>button('Googleアカウントを選択').click());await settle(()=>expect(host.textContent).toContain('owner@example.test'));};
 try {
  await act(async()=>render());expect(request).not.toHaveBeenCalled();await connect();
  const dates=host.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]');await fill(dates[0]!,'2026-09-20T10:00');await fill(dates[1]!,'2026-09-20T10:30');
  await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await settle(()=>expect(host.textContent).toContain('確認待ち'));expect(postCount).toBe(0);
  await act(async()=>button('この内容を承認してGoogleに登録').click());await settle(()=>expect(host.textContent).toContain('結果不明・再確認が必要'));expect(postCount).toBe(1);
  expect(JSON.stringify(await new CalendarActionStore().list(projectId))).not.toContain('test-ephemeral');
  await act(async()=>root.unmount());root=createRoot(host);await act(async()=>render());
  await settle(()=>expect(host.textContent).toContain('結果不明・再確認が必要'));expect(postCount).toBe(1);
  expect(button('登録結果を再確認（再送しません）').disabled).toBe(true);await connect();
  await act(async()=>button('登録結果を再確認（再送しません）').click());await settle(()=>expect(host.textContent).toContain('登録を確認済み'));
  expect(postCount).toBe(1);expect((await new CalendarActionStore().list(projectId))[0]!.state).toBe('verified');
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
it('has no cloud/network path in strict local mode',async()=>{
 const request=vi.fn();vi.stubGlobal('fetch',request);const host=document.createElement('div');const root=createRoot(host);
 try{await act(async()=>root.render(<CalendarActions projectId="private" privacyMode="strict_local" clientId="client"/>));expect(host.textContent).toContain('ローカル限定');expect([...host.querySelectorAll('button')].some(b=>b.textContent?.includes('Google'))).toBe(false);expect(request).not.toHaveBeenCalled();}
 finally{await act(async()=>root.unmount());vi.unstubAllGlobals();}
});
