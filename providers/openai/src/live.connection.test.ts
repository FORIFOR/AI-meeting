import {expect,it,vi} from 'vitest';
vi.mock('@rcai/audio-core',()=>({createPcmTapNode:async()=>({node:{connect(){}},onChunk(){},dispose(){}})}));
import {OpenAILiveProvider} from './live.js';
it('exchanges SDP once, waits for session.started, and closes before releasing transport',async()=>{
 const sent:any[]=[];const order:string[]=[];
 class Stream {tracks:any[]=[];getAudioTracks(){return this.tracks;}addTrack(t:any){this.tracks.push(t);}}
 vi.stubGlobal('MediaStream',Stream);
 vi.stubGlobal('AudioContext',class {async resume(){}createGain(){return {gain:{value:1},connect(){}};}createMediaStreamSource(){return {connect(){}};}async close(){order.push('audio-close');}});
 const dc:any={readyState:'open',onmessage:null,onclose:null,send(data:string){const event=JSON.parse(data);sent.push(event);if(event.type==='session.close'){order.push('close-command');queueMicrotask(()=>dc.onmessage?.({data:JSON.stringify({type:'session.closed',usage:{seconds:6}})}));}},close(){order.push('channel-close');}};
 const pc:any={iceGatheringState:'complete',createDataChannel(){return dc;},addTrack(){},async createOffer(){return {type:'offer',sdp:'v=0'};},async setLocalDescription(o:any){this.localDescription=o;},async setRemoteDescription(o:any){expect(o.sdp).toBe('answer');this.ontrack({track:{}});dc.onmessage({data:JSON.stringify({type:'session.started'})});},close(){order.push('peer-close');}};
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({session:{id:'live_test'},transport:{sdp:'answer'}})));
 const p=new OpenAILiveProvider({brokerUrl:'https://broker',fetch:fetcher,createPeerConnection:()=>pc});
 p.attachInputStream(new Stream() as any);
 try{
 await p.connect({systemPrompt:'hello',language:'ja',mode:'free_talk',privacyMode:'default'});
 expect(fetcher).toHaveBeenCalledOnce();expect(sent.some(e=>e.type==='session.start')).toBe(false);
 await p.sendText('hello');expect(sent.slice(-2).map(e=>e.type)).toEqual(['response.item.create','response.create']);
 await p.disconnect();expect(p.usage.finalized).toBe(true);expect(p.usage.seconds).toBe(6);
 expect(order.indexOf('close-command')).toBeLessThan(order.indexOf('peer-close'));
 }finally{vi.unstubAllGlobals();}
});

it.each([
 {name:'normal disconnect',failAfterTrack:false},
 {name:'connection failure after a remote track',failAfterTrack:true},
])('activates remote audio without duplicate playback and releases it on $name',async({failAfterTrack})=>{
 const remoteTrack={kind:'audio'};
 class Stream {tracks:any[]=[];getAudioTracks(){return this.tracks;}addTrack(t:any){this.tracks.push(t);}}
 const played:any[]=[];
 const audio={
  muted:false,autoplay:false,style:{display:''},srcObject:null as any,
  play:vi.fn(function(this:any){played.push({stream:this.srcObject,muted:this.muted,autoplay:this.autoplay});return failAfterTrack?Promise.reject(new Error('Autoplay rejected')):Promise.resolve();}),
  pause:vi.fn(),remove:vi.fn(),
 };
 const appendChild=vi.fn();
 const createElement=vi.fn(()=>audio);
 vi.stubGlobal('document',{createElement,body:{appendChild}});
 vi.stubGlobal('MediaStream',Stream);
 vi.stubGlobal('AudioContext',class {async resume(){}createGain(){return {gain:{value:1},connect(){}};}createMediaStreamSource(){return {connect(){}};}async close(){}});
 const dc:any={readyState:'open',onmessage:null,onclose:null,send(data:string){if(JSON.parse(data).type==='session.close')queueMicrotask(()=>dc.onmessage?.({data:JSON.stringify({type:'session.closed',usage:{seconds:6}})}));},close:vi.fn()};
 const pc:any={iceGatheringState:'complete',createDataChannel(){return dc;},addTrack(){},async createOffer(){return {type:'offer',sdp:'v=0'};},async setLocalDescription(o:any){this.localDescription=o;},async setRemoteDescription(){this.ontrack({track:remoteTrack});if(failAfterTrack)throw new Error('Remote negotiation failed');dc.onmessage({data:JSON.stringify({type:'session.started'})});},close:vi.fn()};
 const p=new OpenAILiveProvider({brokerUrl:'https://broker',fetch:vi.fn(async()=>new Response(JSON.stringify({transport:{sdp:'answer'}}))),createPeerConnection:()=>pc});
 p.attachInputStream(new Stream() as any);
 try{
  const connecting=p.connect({systemPrompt:'hello',language:'ja',mode:'free_talk',privacyMode:'default'});
  if(failAfterTrack)await expect(connecting).rejects.toThrow('Remote negotiation failed');
  else {await connecting;expect(audio.srcObject).toBe(p.getOutputStream());await p.disconnect();}
  expect(createElement).toHaveBeenCalledExactlyOnceWith('audio');
  expect(appendChild).toHaveBeenCalledExactlyOnceWith(audio);
  expect(audio.style.display).toBe('none');
  expect(audio.play).toHaveBeenCalledOnce();
  expect(played).toHaveLength(1);expect(played[0].muted).toBe(true);expect(played[0].autoplay).toBe(true);
  expect(played[0].stream.getAudioTracks()).toEqual([remoteTrack]);
  expect(audio.pause).toHaveBeenCalledOnce();expect(audio.srcObject).toBeNull();expect(audio.remove).toHaveBeenCalledOnce();
  expect(pc.close).toHaveBeenCalledOnce();expect(dc.close).toHaveBeenCalledOnce();expect(p.getOutputStream()).toBeNull();
 }finally{vi.unstubAllGlobals();}
});
