// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveCuePanel, type LiveCuePanelProps } from './LiveCuePanel.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, div: HTMLDivElement;
const base = (): LiveCuePanelProps => ({ captions:[{id:1,role:'user',text:'予算確認を先に進めたい',final:false}],tasks:[{id:'1',title:'予算確認',status:'pending'}],active:true,brokerUrl:'https://broker.example',privacyMode:'default',onCue:vi.fn() });
async function render(props: LiveCuePanelProps) { await act(async()=>root.render(<LiveCuePanel {...props}/>)); }
async function advance(ms = 220) { await act(async()=>{ await vi.advanceTimersByTimeAsync(ms); }); }
function enter(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
  input.dispatchEvent(new Event('input',{bubbles:true}));
}
beforeEach(()=>{ vi.useFakeTimers(); div=document.createElement('div'); document.body.append(div); root=createRoot(div); });
afterEach(async()=>{ await act(async()=>root.unmount());div.remove();vi.useRealTimers();vi.unstubAllGlobals(); });

describe('live cue panel',()=>{
  it('shows a known reference from a partial transcript, with no cloud request or task write',async()=>{
    const network=vi.fn();vi.stubGlobal('fetch',network);const props=base(),before=structuredClone(props.tasks);
    await render(props);await advance();expect(div.querySelector('.live-cues__title')?.textContent).toBe('予算確認');
    expect(div.textContent).toContain('ローカル');expect(div.textContent).toContain('参考表示');expect(network).not.toHaveBeenCalled();
    expect(props.tasks).toEqual(before);expect(props.onCue).toHaveBeenCalledWith('plan');
  });
  it('clears the previous hint on interruption even while old captions remain visible',async()=>{
    const props=base();await render({...props,transcript:props.captions[0]!.text});await advance();
    expect(div.querySelector('.live-cues__title')).not.toBeNull();
    await render({...props,transcript:''});await advance();expect(div.querySelector('.live-cues__title')).toBeNull();
    expect(props.onCue).toHaveBeenLastCalledWith('none');
  });
  it('disables hints on mute/end and respects an explicit display opt-out',async()=>{
    const props=base();await render(props);await advance();
    await act(async()=>{(div.querySelector('input[type=checkbox]') as HTMLInputElement).click();});
    await advance();expect(div.querySelector('.live-cues__title')).toBeNull();expect(div.textContent).toContain('オフ');
    await render({...props,active:false});await advance();expect(props.onCue).toHaveBeenLastCalledWith('none');
  });
  it('never offers cloud credentials in strict_local or team sessions',async()=>{
    const network=vi.fn();vi.stubGlobal('fetch',network);const props=base();
    await render({...props,privacyMode:'strict_local'});await advance();expect(div.querySelector('input[type=password]')).toBeNull();
    await render({...props,team:true});await advance();expect(div.querySelector('input[type=password]')).toBeNull();expect(network).not.toHaveBeenCalled();
  });
  it('requires explicit session consent and drops the scoped token when the broker changes',async()=>{
    const network=vi.fn(async()=>new Response(JSON.stringify({candidateId:'task_0',intent:'plan',source:'jev',confidence:.9})));
    vi.stubGlobal('fetch',network);const props=base();await render(props);await advance();expect(network).not.toHaveBeenCalled();
    await act(async()=>enter(div.querySelector('input[type=password]')!, 'decision-only-token-abcdefghijklmnopqrstuvwxyz'));
    await advance();expect(network).not.toHaveBeenCalled();
    await act(async()=>{Array.from(div.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).at(-1)!.click();});
    await advance();expect(network).toHaveBeenCalledOnce();expect(div.querySelector('summary')?.textContent).toContain('Jev');
    await render({...props,brokerUrl:'https://different.example'});await advance(2000);
    expect(network).toHaveBeenCalledOnce();expect((div.querySelector('input[type=password]') as HTMLInputElement).value).toBe('');
  });
  it('falls back visibly on provider failure without changing the task',async()=>{
    const network=vi.fn(async()=>new Response('{}',{status:503}));vi.stubGlobal('fetch',network);
    const props=base();await render(props);
    await act(async()=>enter(div.querySelector('input[type=password]')!, 'decision-only-token-abcdefghijklmnopqrstuvwxyz'));
    await act(async()=>{Array.from(div.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).at(-1)!.click();});
    await advance();expect(div.textContent).toContain('ローカル照合で続けています');expect(props.tasks[0]?.status).toBe('pending');
  });
  it('does not bubble a hint control click to the stage interruption handler',async()=>{
    const click=vi.fn();await act(async()=>root.render(<div onClick={click}><LiveCuePanel {...base()}/></div>));
    await act(async()=>div.querySelector('summary')!.click());expect(click).not.toHaveBeenCalled();
  });
});
