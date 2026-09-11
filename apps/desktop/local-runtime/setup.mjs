import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,rename,stat,rm,readdir} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export async function sha256(file) {const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
export function recommendedProfile(memoryGB) {return memoryGB>=24?'standard':'lite';}
export async function download(file, root, signal, progress=()=>{}) {
 const target=path.join(root,file.path);await mkdir(path.dirname(target),{recursive:true});
 try{if(await sha256(target)===file.sha256){progress(file.bytes);return target;}}catch{}
 const partial=target+'.partial';let offset=await stat(partial).then(s=>s.size).catch(()=>0);
 if(offset>file.bytes){await rm(partial);offset=0;}
 if(offset<file.bytes){
  const response=await fetch(file.url,{headers:offset?{Range:`bytes=${offset}-`}:{},signal});
  if(!response.ok)throw Error(`ダウンロードに失敗しました（${response.status}）。再試行してください。`);
  if(offset && response.status!==206)offset=0;
  if(offset && !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`))throw Error('再開位置を確認できません。');
  let received=offset;const stream=Readable.fromWeb(response.body);stream.on('data',b=>{received+=b.length;progress(received);});
  await pipeline(stream,createWriteStream(partial,{flags:offset?'a':'w'}),{signal});
 }
 if(await sha256(partial)!==file.sha256){await rm(partial);throw Error('ファイルの検証に失敗しました。再試行してください。');}
 await rename(partial,target);return target;
}
async function find(root,name){for(const entry of await readdir(root,{withFileTypes:true})){const p=path.join(root,entry.name);if(entry.name===name&&entry.isFile())return p;if(entry.isDirectory()){const found=await find(p,name);if(found)return found;}}}
async function main(){
 const [root,action,profile='lite',parent]=process.argv.slice(2);if(!root||!['install','start'].includes(action)||!['lite','standard'].includes(profile))throw Error('Invalid setup arguments');
 const bundle=path.dirname(fileURLToPath(import.meta.url));const models=JSON.parse(await readFile(path.join(bundle,'models.json'),'utf8')).filter(f=>f.profile===profile||f.profile==='speech');
 await mkdir(root,{recursive:true});const stateFile=path.join(root,'status.json');const controller=new AbortController();const children=[];let stopping=false;let state={phase:'checking',message:'環境を確認しています',profile,downloaded:0,total:models.reduce((n,f)=>n+f.bytes,0)};let lastWrite=0;
 function report(patch,force=true){Object.assign(state,patch);if(!force&&Date.now()-lastWrite<300)return;lastWrite=Date.now();const temp=stateFile+'.tmp';// Serialize synchronous writes: no overlapping snapshots.
  const fs=requireFs;fs.writeFileSync(temp,JSON.stringify(state));fs.renameSync(temp,stateFile);
 }
 const stop=()=>{if(stopping)return;stopping=true;controller.abort();for(const c of children)c.kill('SIGTERM');report({phase:'stopped',message:'ローカルAIを停止しました'});setTimeout(()=>{for(const c of children)c.kill('SIGKILL');process.exit(0);},1500).unref();};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 const parentWatch=setInterval(()=>{try{process.kill(Number(parent),0);}catch{stop();}},3000);parentWatch.unref();
 function launch(exe,args,env={}) {const c=spawn(exe,args,{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME,LANG:'ja_JP.UTF-8',...env},stdio:'ignore'});children.push(c);c.on('error',()=>{if(!stopping){report({phase:'error',message:'実行環境を起動できませんでした。アプリを再起動してください。'});for(const other of children)other.kill('SIGTERM');process.exitCode=1;}});return c;}
 async function waitReady(url,check){for(let i=0;i<120;i++){if(stopping)throw Error('中止しました');if(children.some(c=>c.exitCode!==null||c.signalCode!==null))throw Error('ローカルAIの起動に失敗しました。メモリの空きを確認してください。');try{const r=await fetch(url,{signal:AbortSignal.timeout(1500)});if(r.ok&&check(await r.json()))return;}catch{}await new Promise(r=>setTimeout(r,1000));}throw Error('起動がタイムアウトしました。ほかのアプリを閉じて再試行してください。');}
 try{
  // Never attach to an unrelated service using our dedicated loopback ports.
  for(const port of [18788,18080]){const net=await import('node:net');await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',()=>reject(Error(`ポート ${port} は使用中です。ほかのAIミーティングを終了してください。`)));s.listen(port,'127.0.0.1',()=>s.close(resolve));});}
  let done=0;
  for(const file of models){report({phase:'downloading',message:file.profile==='speech'?'音声認識モデルを準備しています':'会話モデルを準備しています'});
   if(action==='start'){if(await sha256(path.join(root,'models',file.path)).catch(()=>null)!==file.sha256)throw Error('モデルが未導入です。「ダウンロードして使う」を選んでください。');}
   else await download(file,path.join(root,'models'),controller.signal,n=>report({downloaded:done+n},false));done+=file.bytes;report({downloaded:done});
  }
  report({phase:'starting',message:'ローカルAIを起動しています'});
  const llama=await find(bundle,'llama-server');if(!llama)throw Error('実行環境が同梱されていません。最新版をインストールしてください。');
  const llmFile=models.find(f=>f.profile===profile);
  launch(llama,['-m',path.join(root,'models',llmFile.path),'--host','127.0.0.1','--port','18080','-c','8192','-np','1','-ngl','99']);
  await waitReady('http://127.0.0.1:18080/health',()=>true);
  launch(process.execPath,[path.join(bundle,'server.js')],{PORT:'18788',LOCAL_LLM_URL:'http://127.0.0.1:18080/v1',LOCAL_LLM_MODEL:'local',LOCAL_STT:'sherpa',SHERPA_MODEL_DIR:path.join(root,'models/speech'),LOCAL_TTS:'say',SAY_VOICE:'Kyoko',LOCAL_TURN:'off',LOCAL_STT_MODE:'baseline',LOCAL_LLM_HEDGE_MS:'0',LOCAL_LLM_KEEP_WARM_MS:'0'});
  report({phase:'testing',message:'音声認識・会話・読み上げを確認しています'});
  await waitReady('http://127.0.0.1:18788/health',h=>h.stt?.ready&&h.llm?.ready&&h.tts?.ready);
  const test=await fetch('http://127.0.0.1:18080/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'local',messages:[{role:'user',content:'「準備できました」とだけ答えてください。'}],max_tokens:24}),signal:AbortSignal.timeout(60000)});
  const result=await test.json();if(!test.ok||!result.choices?.[0]?.message?.content)throw Error('会話の動作確認に失敗しました。');
  await writeFile(path.join(root,'installed.json'),JSON.stringify({profile,version:1}));
  report({phase:'ready',message:'ローカルAIを利用できます',downloaded:state.total});
  const watch=setInterval(async()=>{if(stopping){clearInterval(watch);return;}if(children.some(c=>c.exitCode!==null||c.signalCode!==null)){report({phase:'error',message:'ローカルAIが停止しました。再起動してください。'});for(const c of children)c.kill('SIGTERM');clearInterval(watch);}},1500);
 }catch(e){for(const c of children)c.kill('SIGTERM');if(!stopping)report({phase:'error',message:e.message});process.exitCode=1;}
}
import * as requireFs from 'node:fs';
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
