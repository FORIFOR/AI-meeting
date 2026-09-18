// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {ProjectWorkspace} from './state/projectWorkspace.js';
import {App} from './App.js';
const live=vi.hoisted(()=>({props:null as any}));
vi.mock('./components/CreditBalance.js',()=>({CreditBalance:()=>null}));
vi.mock('./api/health.js',()=>({shouldProbeLocalAgent:()=>false,probe:async()=>({broker:null,agent:null,availability:{openai:false,google:false,local:true}})}));
vi.mock('./integrations/registry.js',()=>({loadPersonas:async()=>({personas:[{id:'task',mode:'task_planning',name:'タスク整理'}]}),loadCharacterEntries:async()=>({entries:[{id:'new-character',name:'別のキャラクター',renderer:'canvas',baseUrl:'/c'}]})}));
vi.mock('./screens/Session.js',()=>({Session:(props:any)=>{live.props=props;return <main>音声デバイス・モデルを置き換えたテスト会話画面<button onClick={()=>props.onEnded({record:{turns:[]},tasks:[]})}>会話を終了</button></main>;}}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
async function settle(check:()=>void){await vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,5));});check();});}
it('routes projects through the actual App to isolated tasks, model context and reviewed result',async()=>{
 const project=await new ProjectWorkspace().save({title:'引継ぎテスト',goal:'次の一歩',decisions:['予算を先に確認する'],openQuestions:['担当者'],nextSteps:[]});
 history.replaceState(null,'','/#projects');const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const button=(label:string)=>[...host.querySelectorAll('button')].find(x=>x.textContent===label)!;
 try {
  await act(async()=>{root.render(<App/>);await vi.dynamicImportSettled();});
  await settle(()=>expect(host.textContent).toContain('引継ぎテスト'));
  await act(async()=>host.querySelector<HTMLButtonElement>('.project-grid button')!.click());
  await settle(()=>expect(button('この案件の続きから話す').disabled).toBe(false));
  await act(async()=>button('この案件の続きから話す').click());
  await settle(()=>expect(live.props?.params.projectId).toBe(project.id));
  expect(live.props.character.id).toBe('new-character');expect(live.props.params.projectContext).toContain('予算を先に確認する');
  await live.props.taskWorkspace.add('別のキャラクターで続ける','明日');
  await act(async()=>button('会話を終了').click());
  await settle(()=>expect(host.textContent).toContain('決まったことだけ、次回へ'));
  await act(async()=>button('保存せず戻る').click());
  await settle(()=>expect(host.textContent).toContain('別のキャラクターで続ける'));
  expect((await new ProjectWorkspace().read(project.id))!.revision).toBe(1); // no silent summary save
 }finally{await act(async()=>root.unmount());host.remove();history.replaceState(null,'','/');}
});
