import { createAvatarProvider } from './registry.js';
import { AvatarRuntime, loadCharacter, type AvatarProvider } from '@rcai/avatar-core';
import { SpeakerOutput, createFrame } from '@rcai/audio-core';
import { BehaviorEngine } from '@rcai/behavior-engine';

const mount = document.getElementById('vrm-demo') ?? document.body;
mount.innerHTML = `<style>
:root{font-family:system-ui,sans-serif;color:#29263b;background:#f6f5fa}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:32px 24px}header{margin-bottom:24px}h1{font-size:32px;margin:8px 0}p{line-height:1.75}.layout{display:grid;grid-template-columns:minmax(300px,1fr) minmax(300px,1fr);gap:28px}.stage{height:580px;position:relative;overflow:hidden;background:#ebe8f4;border:1px solid #dcd7eb;border-radius:28px}.stage canvas{display:block;width:100%;height:100%}.panel{padding:28px;background:white;border:1px solid #e5e0ee;border-radius:24px}button,.back{font:inherit;border:1px solid #cec8de;border-radius:12px;background:white;color:inherit;padding:12px 18px;cursor:pointer}.primary{background:#6750c9;color:white;border:0}button:disabled{opacity:.5;cursor:default}.buttons{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}label{display:block;margin:22px 0 8px;font-weight:650}input{max-width:100%}.status{font-size:14px;color:#625874;min-height:3em}pre{font:12px ui-monospace,monospace;white-space:pre-wrap;overflow:auto;background:#f6f5fa;padding:16px;border-radius:12px}a{color:#5943b1}.foot{font-size:13px;color:#625874}@media(max-width:740px){.layout{grid-template-columns:1fr}.stage{height:460px}main{padding:20px 14px}}
</style><main><header><a href="/">AIミーティング</a><h1>音声と3D表示を試す</h1><p>APIキーなしで、口パク・表情・割り込みを確認できます。モデルと音声のファイルは、このブラウザー内で処理します。</p></header><div class="layout"><div id="stage" class="stage" aria-label="VRMのプレビュー"></div><section class="panel"><h2>まずは口パクを確認</h2><p>テスト音、または手元の音声を再生します。AIとの会話には、別途音声AIの設定が必要です。</p><div class="buttons"><button id="play" class="primary" disabled>テスト音で口パク</button><button id="stop">音声を止める</button></div><label for="audio">音声ファイルを試す</label><input id="audio" type="file" accept="audio/*"><p class="foot">180秒・30MBまで。音声はアップロードしません。</p><label for="model">自分のVRMを開く</label><input id="model" type="file" accept=".vrm"><p class="foot">VRM 0.0 / 1.0・50MBまで。利用条件を確認したファイルを選んでください。外部リソースを参照するモデルには対応しません。</p><div class="buttons"><button id="sample">サンプルに戻す</button><button id="listen">聞く</button><button id="think">考える</button></div><p id="status" class="status" role="status">モデルを準備しています…</p><details><summary>表示の診断</summary><pre id="diagnostics"></pre></details><p class="foot">同梱モデル：VRM1_Constraint_Twist_Sample © 2022 pixiv Inc.。製品専用キャラクターではありません。<a href="/characters/vrm-sample/LICENSE.md" target="_blank" rel="noreferrer">モデルの利用条件</a></p></section></div></main>`;
const stage = document.getElementById('stage')!;
const status = document.getElementById('status')!;
const diagnostics = document.getElementById('diagnostics')!;
const playButton = document.getElementById('play') as HTMLButtonElement;
let avatar: AvatarProvider | null = null, runtime: AvatarRuntime | null = null, behavior: BehaviorEngine | null = null, speaker: SpeakerOutput | null = null;
let detach: (() => void) | undefined, revision = 0, generation = 0, sequence = 0, modelObjectURL: string | null = null, disposed = false;
let requested = 'VRM 1.0 サンプル';
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const setStatus = (text: string) => { status.textContent = text; };
function interrupt() {
  sequence++; generation++;
  speaker?.interrupt(generation);
  runtime?.handleEvent({ type: 'interrupted', at: performance.now() });
  setStatus('音声と口パクを停止しました。');
}
async function releaseAvatar() {
  interrupt(); detach?.(); detach = undefined; behavior?.stop(); behavior = null;
  const oldRuntime = runtime, old = avatar; runtime = null; avatar = null;
  if (oldRuntime) await oldRuntime.dispose(); else await old?.stop();
}
async function loadModel(url?: string) {
  const version = ++revision;
  playButton.disabled = true;
  await releaseAvatar();
  if (disposed || version !== revision) return;
  const def = await loadCharacter('/characters/vrm-sample');
  if (disposed || version !== revision) return;
  const current = await createAvatarProvider('vrm', {container:stage,brokerUrl:'',modelUrl:url,privacyMode:'strict_local',quality:'lightweight',characterName:'VRMサンプル',onFallback:()=>setStatus('モデルを読み込めませんでした。簡易表示で続けます。別のVRMを選べます。')});
  if (disposed || version !== revision) { await current.stop(); return; }
  avatar = current;
  await current.prepare(def);
  if (disposed || version !== revision) { await current.stop(); return; }
  runtime = new AvatarRuntime(current);
  behavior = new BehaviorEngine(runtime, {mode:'free_talk'});
  await current.start();
  if (disposed || version !== revision) { await current.stop(); return; }
  behavior.start();
  if (speaker) { detach?.(); detach = speaker.tap.subscribe(frame => runtime?.pushAudio(frame)); }
  playButton.disabled = false;
  if (current.id === 'vrm') setStatus('準備できました。音声を再生すると、口パクが動きます。');
}
async function output() {
  if (!speaker) { speaker = new SpeakerOutput(); detach = speaker.tap.subscribe(frame => runtime?.pushAudio(frame)); }
  await speaker.resume(); await speaker.whenReady(); return speaker;
}
async function play(data: Float32Array, rate: number) {
  if (!runtime || disposed) return;
  interrupt();
  const own = ++sequence, gen = ++generation, out = await output();
  if (own !== sequence || disposed) return;
  runtime.handleEvent({type:'assistant_speech_started', at:performance.now()});
  setStatus('再生中です。「音声を止める」で、口パクも止まります。');
  const chunk = Math.round(rate * .1);
  for (let index=0;index<data.length;index+=chunk) {
    if (own !== sequence || disposed) return;
    out.play(createFrame(data.slice(index,index+chunk),rate),{generationId:gen});
    if (out.queuedAudioMs>220) await delay(100);
  }
  while (out.isPlaying && own===sequence && !disposed) await delay(30);
  if (own!==sequence || disposed) return;
  runtime.handleEvent({type:'assistant_speech_ended',at:performance.now()});
  setStatus('再生が終わりました。無音時には口が閉じます。');
}
function testTone() {
  const rate=48000, data=new Float32Array(rate*4);
  const bands=[[800,1200],[300,2300],[350,800],[500,1800],[500,900]];
  bands.forEach(([f1,f2],i)=>{for(let j=0;j<rate*.5;j++){const t=j/rate,envelope=Math.min(1,t/.04,(.5-t)/.06);data[Math.round((i*.7+.15)*rate)+j]=.12*envelope*(Math.sin(2*Math.PI*140*t)+.5*Math.sin(2*Math.PI*f1!*t)+.35*Math.sin(2*Math.PI*f2!*t));}});
  return play(data,rate);
}
const safely=(action:()=>Promise<unknown>)=>{void action().catch(error=>setStatus(error instanceof Error?error.message:'準備に失敗しました。'));};
playButton.onclick=()=>safely(testTone);
document.getElementById('stop')!.onclick=interrupt;
document.getElementById('listen')!.onclick=()=>{interrupt();runtime?.handleEvent({type:'user_speech_started',at:performance.now()});setStatus('聞いている時の動きを表示しています。');};
document.getElementById('think')!.onclick=()=>{interrupt();runtime?.handleEvent({type:'assistant_thinking'});setStatus('考えている時の動きを表示しています。');};
(document.getElementById('audio') as HTMLInputElement).onchange=event=>safely(async()=>{
  const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;
  if(file.size>30*1024*1024)throw new Error('音声は30MB以内を選んでください。');
  interrupt(); const own = sequence, version = revision;
  const out=await output(), buffer=await out.context.decodeAudioData(await file.arrayBuffer());
  if (disposed || own !== sequence || version !== revision) return;
  if(buffer.duration>180)throw new Error('音声は180秒以内を選んでください。');
  const mono=new Float32Array(buffer.length);for(let ch=0;ch<buffer.numberOfChannels;ch++){const input=buffer.getChannelData(ch);for(let i=0;i<mono.length;i++)mono[i]=(mono[i]??0)+(input[i]??0)/buffer.numberOfChannels;}
  await play(mono,buffer.sampleRate);
});
(document.getElementById('model') as HTMLInputElement).onchange=event=>safely(async()=>{
  const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;
  if(file.size>50*1024*1024)throw new Error('モデルは50MB以内を選んでください。');
  const next=URL.createObjectURL(file),old=modelObjectURL;modelObjectURL=next;requested='選択したローカルVRM';
  try{await loadModel(next);}finally{if(old)URL.revokeObjectURL(old);}
});
document.getElementById('sample')!.onclick=()=>safely(async()=>{const old=modelObjectURL;modelObjectURL=null;requested='VRM 1.0 サンプル';try{await loadModel();}finally{if(old)URL.revokeObjectURL(old);}});
const poll=setInterval(()=>{const detail=(avatar as AvatarProvider & {getLipSyncDiagnostics?:()=>unknown})?.getLipSyncDiagnostics?.();diagnostics.textContent=JSON.stringify({requested,actual:avatar?.id??'loading',state:runtime?.state??'IDLE',lipSync:detail,mouth:avatar?.getParams?.().mouthOpenY??0,queuedAudioMs:speaker?.queuedAudioMs??0,externalAvatarAPI:false},null,2);},250);
window.addEventListener('pagehide',()=>{disposed=true;revision++;clearInterval(poll);void releaseAvatar();void speaker?.close();if(modelObjectURL)URL.revokeObjectURL(modelObjectURL);});
safely(()=>loadModel());
