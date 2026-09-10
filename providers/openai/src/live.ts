import { createPcmTapNode, type PCMFrame, type PcmTapNode } from '@rcai/audio-core';
import type { ConversationContext, ConversationEvent, ConversationEventListener, SessionConfig } from '@rcai/conversation-core';
import { privacyGuard, type RealtimeAIProvider } from '@rcai/provider-core';

/** GPT-Live's separate WebRTC protocol. No Realtime response.create/cancel events. */
export class OpenAILiveProvider implements RealtimeAIProvider {
 readonly id='openai' as const;
 readonly fullDuplex=true;
 private trackResolve:(()=>void)|null=null;
 private closeTask:Promise<void>|null=null;
 private listeners=new Set<ConversationEventListener>();
 private pc:RTCPeerConnection|null=null;
 private dc:RTCDataChannel|null=null;
 private input:MediaStream|null=null;
 private output:MediaStream|null=null;
 private ctx:AudioContext|null=null;
 private tap:PcmTapNode|null=null;
 private speaking=false;
 private silentSince=0;
 private suppressed=false;
 private ready=false;
 private finalized=false;
 private closeResolve:(()=>void)|null=null;
 private startResolve:(()=>void)|null=null;
 private startReject:((e:Error)=>void)|null=null;
 readonly usage={model:'gpt-live-1',seconds:0,finalized:false};
 constructor(private readonly opts:{brokerUrl:string;fetch?:typeof fetch;createPeerConnection?:()=>RTCPeerConnection}){}
 capabilities(){return {nativeAudio:true,vision:false,toolCalling:false,realtimeTranscript:true,interruption:true,emotionUnderstanding:false,localOnly:false,extras:{webrtc:true,fullDuplex:true}};}
 onEvent(cb:ConversationEventListener){this.listeners.add(cb);}
 private emit(e:ConversationEvent){for(const cb of this.listeners)cb(e);}
 attachInputStream(s:MediaStream){this.input=s;}
 getOutputStream(){return this.output;}
 pushAudio(_frame:PCMFrame){} // Negotiated microphone track is the only input path.
 async connect(config:SessionConfig){
  privacyGuard.assert(config.privacyMode,'cloud_conversation');
  if(!this.input)throw new Error('GPT-Live requires a microphone stream');
  const pc=this.pc=this.opts.createPeerConnection?.()??new RTCPeerConnection();
  this.output=new MediaStream();
  const tracked=new Promise<void>(resolve=>{this.trackResolve=resolve;});
  const ctx=this.ctx=new AudioContext();await ctx.resume();
  this.tap=await createPcmTapNode(ctx,10);
  // Analysis only: SpeakerOutput owns audible playback and lip sync.
  const mute=ctx.createGain();mute.gain.value=0;this.tap.node.connect(mute);mute.connect(ctx.destination);
  this.tap.onChunk(pcm=>this.observeAudio(pcm));
  pc.ontrack=e=>{this.output!.addTrack(e.track);this.trackResolve?.();ctx.createMediaStreamSource(new MediaStream([e.track])).connect(this.tap!.node);};
  for(const t of this.input.getAudioTracks())pc.addTrack(t,this.input);
  const dc=this.dc=pc.createDataChannel('oai-events');
  dc.onmessage=e=>{try{this.handleEvent(JSON.parse(e.data));}catch{this.emit({type:'error',error:new Error('Invalid Live event')});}};
  dc.onclose=()=>{if(!this.finalized){this.startReject?.(new Error('Live connection closed before startup'));this.emit({type:'error',error:new Error('GPT-Live connection lost; final usage unconfirmed')});}this.closeResolve?.();};
  let timer:ReturnType<typeof setTimeout>;
  const started=new Promise<void>((resolve,reject)=>{this.startResolve=resolve;this.startReject=reject;timer=setTimeout(()=>reject(new Error('GPT-Live startup timeout')),30000);});
  started.catch(()=>{});
  try{
   await pc.setLocalDescription(await pc.createOffer());
   if(pc.iceGatheringState!=='complete')await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',check);reject(new Error('ICE timeout'));},10000);
    const check=()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timeout);pc.removeEventListener('icegatheringstatechange',check);resolve();}};
    pc.addEventListener('icegatheringstatechange',check);check();
   });
   const response=await (this.opts.fetch??fetch)(`${this.opts.brokerUrl.replace(/\/$/,'')}/api/session/openai-live`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sdp:pc.localDescription?.sdp,instructions:config.systemPrompt}),signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw new Error(`GPT-Live could not start (${response.status})`);
   const answer=await response.json() as {transport:{sdp:string}};
   await pc.setRemoteDescription({type:'answer',sdp:answer.transport.sdp});
   await started;let trackTimer:ReturnType<typeof setTimeout>;try{await Promise.race([tracked,new Promise<void>((_,reject)=>{trackTimer=setTimeout(()=>reject(new Error('GPT-Live audio track unavailable')),5000);})]);}finally{clearTimeout(trackTimer!);}this.emit({type:'session_ready',providerId:this.id});
   const opening=config.providerOptions?.opening;
   if(typeof opening==='string')this.send({type:'session.instructions.append',delegation_id:null,content:`今すぐ日本語で短く挨拶してから聞いてください。挨拶: ${opening.slice(0,300)}`});
  }catch(e){await this.cleanup();throw e;}finally{clearTimeout(timer!);this.startResolve=null;this.startReject=null;}
 }
 private observeAudio(pcm:Float32Array){
  let peak=0;for(const x of pcm)peak=Math.max(peak,Math.abs(x));
  const now=performance.now();
  if(peak>.008){this.silentSince=0;if(!this.speaking&&!this.suppressed){this.speaking=true;this.emit({type:'assistant_speech_started'});}}
  else {this.silentSince ||=now;if(now-this.silentSince>180){this.suppressed=false;if(this.speaking){this.speaking=false;this.emit({type:'assistant_speech_ended'});}}}
 }
 /** Deltas have no authoritative turn boundaries; retain fragments without inventing them. */
 handleEvent(e:{type:string;delta?:string;usage?:{seconds?:number};error?:{message?:string}}){
  if(e.type==='session.started'){this.ready=true;this.startResolve?.();}
  if(e.type==='session.input_transcript.delta'&&e.delta)this.emit({type:'user_transcript',text:e.delta,final:false,delta:true});
  if(e.type==='session.output_transcript.delta'&&e.delta)this.emit({type:'assistant_transcript',text:e.delta,final:false});
  if(e.type==='session.usage.updated'||e.type==='session.closed'){
   if(typeof e.usage?.seconds==='number'&&Number.isFinite(e.usage.seconds))this.usage.seconds=Math.max(this.usage.seconds,e.usage.seconds);
   this.emit({type:'usage',provider:this.id,model:'gpt-live-1',at:performance.now(),counters:{sessionSeconds:this.usage.seconds}});
   if(e.type==='session.closed'){this.ready=false;this.finalized=true;this.usage.finalized=true;this.closeResolve?.();}
  }
  if(e.type==='error'){const error=new Error(e.error?.message??'GPT-Live error');if(!this.ready)this.startReject?.(error);this.emit({type:'error',error});}
 }
 private send(e:Record<string,unknown>){if(!this.ready||this.dc?.readyState!=='open')throw new Error('GPT-Live is not ready');this.dc.send(JSON.stringify({...e,event_id:crypto.randomUUID()}));}
 async sendText(text:string){this.send({type:'response.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text}]}});this.send({type:'response.create'});}
 async updateContext(context:ConversationContext){this.send({type:'session.thinking.append',delegation_id:null,content:JSON.stringify({history:context.history?.slice(-2),metadata:context.metadata}).slice(0,600)});}
 async interrupt(){this.suppressed=true;this.speaking=false;this.send({type:'session.instructions.append',delegation_id:null,content:'今の発話を止めて、ユーザーの続きを聞いてください。'});}
 async disconnect(){if(this.closeTask)return this.closeTask;this.closeTask=this.finishClose();return this.closeTask;}
 private async finishClose(){
  if(this.ready&&!this.finalized&&this.dc?.readyState==='open'){
   let timer:ReturnType<typeof setTimeout>;
   const closed=new Promise<void>(resolve=>{this.closeResolve=resolve;timer=setTimeout(resolve,5000);});
   try{this.send({type:'session.close'});await closed;}finally{clearTimeout(timer!);}
   if(!this.finalized)this.emit({type:'error',error:new Error('GPT-Live final usage unconfirmed')});
  }
  await this.cleanup();
 }
 private async cleanup(){this.ready=false;if(this.dc){this.dc.onclose=null;this.dc.onmessage=null;}this.dc?.close();this.pc?.close();this.tap?.dispose();await this.ctx?.close();this.dc=null;this.pc=null;this.ctx=null;this.output=null;}
}
