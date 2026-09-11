import type { BrokerEnv } from '../env.js';
/** Live uses SDP JSON exchange, not Realtime ephemeral credentials. Never retry creation. */
export async function createOpenAILiveSession(env: BrokerEnv, req: {sdp?: string; instructions?: string}, fetchImpl: typeof fetch) {
 if (!env.OPENAI_API_KEY) return {status:503,body:{error:'BLOCKED_BY_OPENAI_KEY'}};
 if (typeof req.sdp !== 'string' || !req.sdp.startsWith('v=0') || req.sdp.length>64000 || (req.instructions !== undefined && (typeof req.instructions!=='string'||req.instructions.length>16000))) return {status:400,body:{error:'invalid_live_session'}};
 const res=await fetchImpl('https://api.openai.com/v1/live/sessions',{
  method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
  body:JSON.stringify({session:{model:'gpt-live-1',store:false,instructions:req.instructions ?? '日本語で短く自然に会話してください。',delegation:{type:'responses',responses:{model:'gpt-5.6-terra',instructions:'Return concise factual results. Do not claim external actions were performed.',max_output_tokens:512,tools:[],tool_choice:'auto'}}},transport:{type:'webrtc',sdp:req.sdp}}),
 });
 if(!res.ok)return {status:res.status===401?503:502,body:{error:'openai_live_session_failed'}};
 const result=await res.json() as {session?:{id?:string};transport?:{sdp?:string}};
 if(!result.session?.id||!result.transport?.sdp)return {status:502,body:{error:'invalid_live_answer'}};
 return {status:201,body:{session:{id:result.session.id},transport:{type:'webrtc',sdp:result.transport.sdp}}};
}
