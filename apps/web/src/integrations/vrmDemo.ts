import './vrmDemo.css';
import { createAvatarProvider } from './registry.js';
import { AvatarRuntime, loadCharacter, type AvatarProvider } from '@rcai/avatar-core';
import { SpeakerOutput, createFrame } from '@rcai/audio-core';
import { BehaviorEngine } from '@rcai/behavior-engine';

const mount = document.getElementById('vrm-demo') ?? document.body;
mount.innerHTML = `<main class="studio">
<nav class="studio-nav" aria-label="メイン"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">a.</span> AI Meeting</a><div><span class="preview-label">INTERACTIVE PREVIEW</span><a href="https://github.com/FORIFOR/AI-meeting" target="_blank" rel="noreferrer">GitHub ↗</a></div></nav>
<section class="studio-hero">
<div class="intro"><p class="eyebrow"><span></span> A LITTLE ROOM TO THINK</p><h1>話せば、<br>少し前に。</h1><p class="lead">アイデアも、今日やることも。<br>表情のある相棒と、ひとつずつ。</p>
<div class="sample-copy"><p class="eyebrow">TRY THE VOICE & EXPRESSIONS</p><p id="caption" class="caption">まずは、声を聞いてみて。</p><div class="transport"><button id="play" class="primary" disabled><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 5 11 7-11 7z"/></svg><span>声と表情を試す</span></button><button id="stop" class="stop" aria-label="音声を止める"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></button></div><p class="micro">録音したAIの応答を再生します。マイクは使いません。</p></div>
<p id="status" class="status" role="status">相棒を準備しています…</p>
</div>
<div class="portrait"><div class="portrait-backdrop" aria-hidden="true"><span class="orbit orbit-one"></span><span class="orbit orbit-two"></span><span class="backdrop-word">hello.</span></div><div id="stage" class="stage" aria-label="動く3Dアバター"></div><div class="presence"><span id="presence-dot"></span><span id="presence-text">準備しています</span></div><div class="character-label"><span>YOUR THINKING PARTNER</span><strong id="character-name">VRoid B</strong></div><div class="reactions" aria-label="表情や動きを試す"><button id="smile">ほほえむ</button><button id="listen">うなずく</button><button id="think">考える</button></div></div>
</section>
<section class="next-step"><div><p class="eyebrow">MAKE IT YOURS</p><h2>次は、あなたの話を。</h2><p>音声AIをつなげると、アイデアの壁打ちやタスクの整理ができます。</p></div><a class="outline-link" href="/">会話の準備をする <span aria-hidden="true">↗</span></a></section>
<details class="customize"><summary>自分のアバターや音声で試す <span aria-hidden="true">＋</span></summary><div class="customize-grid"><div><label for="model">自分のVRMを開く</label><input id="model" type="file" accept=".vrm"><p class="micro">VRM 0.0 / 1.0・50MBまで。外部ファイルのないモデルに対応。</p><button id="sample" class="small-button">VRoid Bに戻す</button></div><div><label for="audio">手元の音声を再生する</label><input id="audio" type="file" accept="audio/*"><p class="micro">180秒・30MBまで。選んだファイルはアップロードしません。</p></div></div><details class="diagnostic"><summary>表示の診断</summary><pre id="diagnostics"></pre></details></details>
<footer><span>AI Meeting · Open source, made for conversation.</span><span>Model: AvatarSample_B © pixiv Inc. / VRoid Project · <a href="/characters/vroid-b/LICENSE.md" target="_blank" rel="noreferrer">利用条件</a></span></footer>
</main>`;
const stage = document.getElementById('stage')!;
const status = document.getElementById('status')!;
const diagnostics = document.getElementById('diagnostics')!;
const playButton = document.getElementById('play') as HTMLButtonElement;
let avatar: AvatarProvider | null = null, runtime: AvatarRuntime | null = null, behavior: BehaviorEngine | null = null, speaker: SpeakerOutput | null = null;
let detach: (() => void) | undefined, revision = 0, generation = 0, sequence = 0, modelObjectURL: string | null = null, disposed = false;
let requested = 'VRoid B';
let prepared = false;
let reactionTimer: ReturnType<typeof setTimeout> | undefined;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const setStatus = (text: string) => { status.textContent = text; };
const caption = document.getElementById('caption')!;
const playbackClass = (playing: boolean) => { mount.classList.toggle('is-playing', playing); };

function interrupt() {
  sequence++; generation++; playbackClass(false);
  if (reactionTimer) clearTimeout(reactionTimer);
  speaker?.interrupt(generation);
  runtime?.handleEvent({ type: 'interrupted', at: performance.now() });
  runtime?.handleEvent({ type: 'session_closed', reason: 'preview_reset' });
  avatar?.setEmotion('warm_positive', 0.25);
  setStatus('音声と口パクを停止しました。');
}
async function releaseAvatar() {
  interrupt(); detach?.(); detach = undefined; behavior?.stop(); behavior = null;
  const oldRuntime = runtime, old = avatar; runtime = null; avatar = null;
  if (oldRuntime) await oldRuntime.dispose(); else await old?.stop();
}
async function loadModel(url?: string) {
  const version = ++revision;
  prepared = false;
  for (const id of ['play','smile','listen','think']) (document.getElementById(id) as HTMLButtonElement).disabled = true;
  await releaseAvatar();
  setStatus('モデルを読み込んでいます…');
  if (disposed || version !== revision) return;
  const def = await loadCharacter('/characters/vroid-b');
  if (disposed || version !== revision) return;
  const current = await createAvatarProvider('vrm', {container:stage,brokerUrl:'',modelUrl:url,privacyMode:'strict_local',quality:'lightweight',characterName:'VRoid B',onFallback:()=>setStatus('モデルを読み込めませんでした。簡易表示で続けます。別のVRMを選べます。')});
  if (disposed || version !== revision) { await current.stop(); return; }
  avatar = current;
  await current.prepare(def);
  if (disposed || version !== revision) { await current.stop(); return; }
  runtime = new AvatarRuntime(current);
  behavior = new BehaviorEngine(runtime, {mode:'free_talk'});
  await current.start();
  if (disposed || version !== revision) { await current.stop(); return; }
  behavior.start();
  current.setEmotion('warm_positive', 0.25);
  document.getElementById('character-name')!.textContent = url ? 'Your avatar' : 'VRoid B';
  if (speaker) { detach?.(); detach = speaker.tap.subscribe(frame => runtime?.pushAudio(frame)); }
  prepared = true;
  for (const id of ['play','smile','listen','think']) (document.getElementById(id) as HTMLButtonElement).disabled = false;
  if (current.id === 'vrm') setStatus('準備できました。声や表情を試してみてください。');
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
  playbackClass(true);
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
  playbackClass(false);
  runtime.handleEvent({type:'assistant_speech_ended',at:performance.now()});
  setStatus('再生が終わりました。無音時には口が閉じます。');
}
async function voiceSample() {
  interrupt(); const own = sequence, version = revision;
  const out = await output();
  const response = await fetch('/demo/voice-sample.m4a');
  if (!response.ok) throw new Error('音声サンプルを読み込めませんでした。もう一度お試しください。');
  const decoded = await out.context.decodeAudioData(await response.arrayBuffer());
  if (disposed || own !== sequence || version !== revision) return;
  caption.textContent = '「資料確認は完了してて、メール返信は明日に延期してるよ。」';
  await play(decoded.getChannelData(0), decoded.sampleRate);
}
function react(kind: 'smile' | 'listen' | 'think') {
  interrupt();
  if (!runtime || !avatar) return;
  if (kind === 'think') {
    runtime.handleEvent({type:'assistant_thinking'});
    avatar.setEmotion('thinking', 0.65);
  } else {
    runtime.handleEvent({type:'user_speech_started',at:performance.now()});
    avatar.setEmotion(kind === 'smile' ? 'smile' : 'warm_positive', kind === 'smile' ? 0.6 : 0.3);
    avatar.performGesture(kind === 'smile' ? 'happy' : 'nod_normal', 0.65);
  }
  setStatus(kind === 'think' ? '考える時の表情です。' : kind === 'smile' ? 'ほほえみと髪の動きも、リアルタイムに。' : 'うなずきながら、話を聞く動きです。');
  reactionTimer = setTimeout(() => { runtime?.handleEvent({type:'session_closed',reason:'preview_reaction_ended'}); avatar?.setEmotion('warm_positive', 0.25); }, 2600);
}
const safely=(action:()=>Promise<unknown>)=>{void action().catch(error=>{interrupt();setStatus(error instanceof Error?error.message:'準備に失敗しました。');});};
playButton.onclick=()=>safely(voiceSample);
document.getElementById('stop')!.onclick=interrupt;
for (const kind of ['smile', 'listen', 'think'] as const) document.getElementById(kind)!.onclick=()=>react(kind);
(document.getElementById('audio') as HTMLInputElement).onchange=event=>safely(async()=>{
  const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;
  if(file.size>30*1024*1024)throw new Error('音声は30MB以内を選んでください。');
  interrupt(); const own = sequence, version = revision;
  const out=await output(), buffer=await out.context.decodeAudioData(await file.arrayBuffer());
  if (disposed || own !== sequence || version !== revision) return;
  if(buffer.duration>180)throw new Error('音声は180秒以内を選んでください。');
  const mono=new Float32Array(buffer.length);for(let ch=0;ch<buffer.numberOfChannels;ch++){const input=buffer.getChannelData(ch);for(let i=0;i<mono.length;i++)mono[i]=(mono[i]??0)+(input[i]??0)/buffer.numberOfChannels;}
  caption.textContent = '手元の音声を再生しています。';
  await play(mono,buffer.sampleRate);
});
(document.getElementById('model') as HTMLInputElement).onchange=event=>safely(async()=>{
  const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;
  if(file.size>50*1024*1024)throw new Error('モデルは50MB以内を選んでください。');
  const next=URL.createObjectURL(file),old=modelObjectURL;modelObjectURL=next;requested='選択したローカルVRM';
  try{await loadModel(next);}finally{if(old)URL.revokeObjectURL(old);}
});
document.getElementById('sample')!.onclick=()=>safely(async()=>{const old=modelObjectURL;modelObjectURL=null;requested='VRoid B';try{await loadModel();}finally{if(old)URL.revokeObjectURL(old);}});
const updateDiagnostics=()=>{
  const state = runtime?.state ?? 'IDLE';
  const labels: Record<string, string> = {IDLE:'そばにいます',LISTENING:'聞いています',THINKING:'考えています',SPEAKING:'話しています',INTERRUPTED:'音声を止めました',REACTING:'反応しています'};
  document.getElementById('presence-text')!.textContent = prepared ? labels[state] ?? labels.IDLE! : '準備しています';
  const detail=(avatar as AvatarProvider & {getLipSyncDiagnostics?:()=>unknown})?.getLipSyncDiagnostics?.();
  const rendering=(avatar as AvatarProvider & {getRenderDiagnostics?:()=>unknown})?.getRenderDiagnostics?.();diagnostics.textContent=JSON.stringify({requested,actual:avatar?.id??'loading',state:runtime?.state??'IDLE',rendering,lipSync:detail,mouth:avatar?.getParams?.().mouthOpenY??0,queuedAudioMs:speaker?.queuedAudioMs??0,externalAvatarAPI:false},null,2);};
let poll=setInterval(updateDiagnostics,250);
let pageCleanup: Promise<unknown> = Promise.resolve();
window.addEventListener('pagehide',()=>{
  disposed=true;prepared=false;revision++;clearInterval(poll);
  const oldSpeaker=speaker;speaker=null;
  pageCleanup=Promise.allSettled([releaseAvatar(),oldSpeaker?.close()]);
  if(modelObjectURL)URL.revokeObjectURL(modelObjectURL);modelObjectURL=null;
});
window.addEventListener('pageshow',event=>{
  if(!event.persisted)return;
  safely(async()=>{await pageCleanup;disposed=false;requested='VRoid B';poll=setInterval(updateDiagnostics,250);await loadModel();});
});
safely(()=>loadModel());
