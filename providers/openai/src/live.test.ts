import {expect,it} from 'vitest';
import {OpenAILiveProvider} from './live.js';
it('retains transcript fragments and cumulative duration without summing snapshots',()=>{
 const p=new OpenAILiveProvider({brokerUrl:'http://unused'}),events:any[]=[];p.onEvent(e=>events.push(e));
 p.handleEvent({type:'session.input_transcript.delta',delta:'今日の'});
 p.handleEvent({type:'session.input_transcript.delta',delta:'予定'});
 expect(events.map(e=>e.text).join('')).toBe('今日の予定');expect(events.every(e=>e.delta===true)).toBe(true);
 p.handleEvent({type:'session.usage.updated',usage:{seconds:12}});
 p.handleEvent({type:'session.usage.updated',usage:{seconds:15}});
 p.handleEvent({type:'session.usage.updated',usage:{seconds:13}});
 expect(p.usage.seconds).toBe(15);expect(p.usage.finalized).toBe(false);
 p.handleEvent({type:'session.closed',usage:{seconds:16}});
 expect(p.usage).toEqual({model:'gpt-live-1',seconds:16,finalized:true});
 expect(p.capabilities().vision).toBe(false);
});
it('strict local refuses Live before accessing media or making a request',async()=>{
 const p=new OpenAILiveProvider({brokerUrl:'http://unused'});
 await expect(p.connect({systemPrompt:'',mode:'free_talk',language:'ja',privacyMode:'strict_local'})).rejects.toThrow('strict_local');
});
