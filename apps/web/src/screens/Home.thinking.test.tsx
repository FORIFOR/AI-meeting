// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Home, type HomeProps } from './Home.js';
vi.mock('../components/CreditBalance.js', () => ({ CreditBalance: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('starts a one-to-one conversation independently of the meeting invitation', async () => {
 const div=document.createElement('div'),root=createRoot(div),talk=vi.fn(),meeting=vi.fn();
 const props={settings:{characterId:'yui',privacyMode:'default'},dispatch:vi.fn(),personas:[],characters:[{id:'yui',name:'Yui',renderer:'live2d'}],broker:null,agent:null,recent:null,onContinue:vi.fn(),onTalk:talk,onCharacter:vi.fn(),onSettings:vi.fn(),onMeeting:meeting} as unknown as HomeProps;
 try {
  await act(async()=>root.render(<Home {...props}/>));
  const button=Array.from(div.querySelectorAll('button')).find(b=>b.textContent?.includes('Yuiと話す'))!;
  await act(async()=>button.click());expect(talk).toHaveBeenCalledOnce();expect(meeting).not.toHaveBeenCalled();
  await act(async()=>div.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(meeting).toHaveBeenCalledWith('');expect(talk).toHaveBeenCalledOnce();
 }finally{await act(async()=>root.unmount());}
});
