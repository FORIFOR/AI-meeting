// @vitest-environment jsdom
import {act} from 'react';import {createRoot} from 'react-dom/client';import {it,expect,vi} from 'vitest';import {LocalSetup} from './LocalSetup.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it('uses only native setup actions and applies loopback strict-local settings after readiness',async()=>{
 let status={phase:'idle',message:'準備できます',memoryGB:16,freeBytes:100e9,supported:true,bundled:true,installed:false,running:false,recommended:'lite'};
 const invoke=vi.fn(async(command:string)=>{if(command==='local_setup_run')status={...status,phase:'ready',running:true};return status;});
 (window as any).__TAURI_INTERNALS__={invoke};const div=document.createElement('div');const root=createRoot(div);const dispatch=vi.fn();const done=vi.fn();
 try{await act(async()=>root.render(<LocalSetup dispatch={dispatch} onReady={done}/>));expect((div.querySelector('select') as HTMLSelectElement).value).toBe('lite');await act(async()=>div.querySelector('button')!.click());expect(invoke).toHaveBeenCalledWith('local_setup_run',{action:'install',profile:'lite'});await act(async()=>div.querySelector('button')!.click());expect(dispatch).toHaveBeenCalledWith({type:'urls',agentUrl:'ws://127.0.0.1:18788',brokerUrl:'http://127.0.0.1:8787'});expect(dispatch).toHaveBeenCalledWith({type:'privacy',mode:'strict_local'});expect(done).toHaveBeenCalledOnce();}finally{await act(async()=>root.unmount());delete (window as any).__TAURI_INTERNALS__;}
});
it('does not offer native installation in a web browser',async()=>{const root=createRoot(document.createElement('div'));const div=document.createElement('div');const r=createRoot(div);try{await act(async()=>r.render(<LocalSetup dispatch={()=>{}} onReady={()=>{}}/>));expect(div.textContent).toContain('Macアプリ内');expect(div.querySelector('button')).toBeNull();}finally{await act(async()=>r.unmount());root.unmount();}});
