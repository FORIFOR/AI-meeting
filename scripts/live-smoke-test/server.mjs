import http from 'node:http';
import {readFile,appendFile} from 'node:fs/promises';
import OpenAI from 'openai';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';

const port=Number(process.env.PORT??4591),origin=`http://127.0.0.1:${port}`;
const apiKey=process.env.OPENAI_API_KEY;
if(!apiKey)throw new Error('Set OPENAI_API_KEY');
const clean=value=>String(value??'').replaceAll(apiKey,'[REDACTED]').replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_-]+/g,'[REDACTED]').slice(0,1600);
const record=async event=>{const line=JSON.stringify({at:new Date().toISOString(),...event});await appendFile(new URL('./evidence.jsonl',import.meta.url),line+'\n',{mode:0o600});console.log(line);};
let currentVariant; let currentBrowser; let currentMethod;
const observedFetch=async(url,options)=>{
 const start=performance.now();const response=await fetch(url,options);
 const raw=await response.clone().text();let data;try{data=JSON.parse(raw);}catch{data={error:raw};}
 await record({kind:'upstream',variant:currentVariant,browser:currentBrowser,method:currentMethod,url:String(url),status:response.status,ms:Math.round(performance.now()-start),contentType:response.headers.get('content-type'),requestId:response.headers.get('x-request-id'),cfRay:response.headers.get('cf-ray'),server:response.headers.get('server'),sessionCreated:!!data.session?.id,hasAnswer:!!data.transport?.sdp,...(!response.ok?{error:clean(typeof data.error==='object'?JSON.stringify(data.error):data.error)}:{})});
 return response;
};
const client=new OpenAI({apiKey,baseURL:'https://api.openai.com/v1',maxRetries:0,timeout:20000,fetch:observedFetch});
let busy=false;const attempts=new Map();
const server=http.createServer(async(req,res)=>{
 const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 try{
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(await readFile(new URL('./index.html',import.meta.url)));return;}
  if(req.method==='GET'&&req.url==='/hello.wav'){res.writeHead(200,{'Content-Type':'audio/wav'});res.end(await readFile(new URL('./hello.wav',import.meta.url)));return;}
  if(req.method!=='POST'||req.headers.origin!==origin){reply(403,{error:'Unexpected request'});return;}
  let raw='';for await(const c of req){raw+=c;if(raw.length>65536){reply(413,{error:'Request too large'});return;}}
  let body;try{body=JSON.parse(raw);}catch{reply(400,{error:'Invalid JSON'});return;}
  if(req.url==='/evidence'){await record({kind:'browser',...body});reply(200,{ok:true});return;}
  if(req.url!=='/api/session'||!['responses','minimal'].includes(body.variant)||typeof body.sdp!=='string'||!body.sdp.startsWith('v=0')||!body.sdp.includes('m=audio')){reply(400,{error:'Invalid offer'});return;}
  const agent=String(req.headers['user-agent']??'unknown'); const method=body.transport==='raw'?'raw':'sdk'; const attemptKey=agent+body.variant+method;
  if(busy||(attempts.get(attemptKey)??0)>=1){reply(409,{error:'Already tested or busy; restart server for an intentional new test'});return;}
  busy=true;currentVariant=body.variant;currentBrowser=agent;currentMethod=method;attempts.set(attemptKey,1);
  try{
   const session={model:'gpt-live-1',instructions:'日本語で簡潔に会話してください。これは接続確認です。ユーザーに一文で短く返事してください。',...(body.variant==='responses'?{delegation:{type:'responses',responses:{model:'gpt-5.6-terra',instructions:'Return concise factual results suitable for a spoken conversation.'}}}:{})};
   const offerHash=createHash('sha256').update(body.sdp).digest('hex');
   await writeFile(new URL('./offer-'+offerHash.slice(0,12)+'.sdp',import.meta.url),body.sdp,{mode:0o600});
   const sdpSummary=body.sdp.split(/\r?\n/).filter(line=>/^(m=|a=rtpmap:|a=fmtp:|a=setup:|a=mid:|a=group:)/.test(line));
   await record({kind:'create',variant:body.variant,method,browser:agent,offerHash,sdpSummary,sdk:'openai@7.15.0',node:process.version,sessionConfig:session,offerBytes:body.sdp.length,hasData:body.sdp.includes('m=application'),hasFingerprint:body.sdp.includes('a=fingerprint:'),retryCount:0});
   const payload={session,transport:{type:'webrtc',sdp:body.sdp}};
   if(method==='raw'){const res=await observedFetch('https://api.openai.com/v1/live/sessions',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data={error:{status:res.status,message:clean(raw)}};}reply(res.status,data);}
   else {const result=await client.live.create(payload);reply(201,result);}
  }catch(e){const error={status:e.status??502,code:clean(e.code),type:clean(e.type),message:clean(e.message),requestId:e.request_id??null};await record({kind:'sdk_error',variant:body.variant,...error});reply(error.status,{error});}
  finally{busy=false;}
 }catch(e){await record({kind:'harness_error',message:clean(e.message)});if(!res.headersSent)reply(500,{error:'Smoke harness failed'});else res.end();}
});
server.listen(port,'127.0.0.1',()=>console.log(`Official SDK smoke ready: ${origin}`));
