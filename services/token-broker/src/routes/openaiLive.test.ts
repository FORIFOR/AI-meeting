import {expect,it,vi} from 'vitest';
import {createOpenAILiveSession} from './openaiLive.js';
it('uses the separate Live JSON exchange and exposes no project key or configuration',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({session:{id:'live_test',instructions:'private'},transport:{sdp:'answer'}}),{status:201}));
 const r=await createOpenAILiveSession({OPENAI_API_KEY:'secret'}, {sdp:'v=0\r\n',instructions:'short'},fetcher);
 const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
 expect(url).toBe('https://api.openai.com/v1/live/sessions');
 const body=JSON.parse(options.body as string);
 expect(body.session.model).toBe('gpt-live-1');expect(body.session.store).toBe(false);
 expect(body.transport.type).toBe('webrtc');expect(body.session.audio).toBeUndefined();
 expect(r.body).toEqual({session:{id:'live_test'},transport:{type:'webrtc',sdp:'answer'}});
});
it('rejects invalid SDP and never retries an upstream failure',async()=>{
 const fetcher=vi.fn(async()=>new Response('private upstream message',{status:403}));
 expect((await createOpenAILiveSession({OPENAI_API_KEY:'secret'},{sdp:'bad'},fetcher)).status).toBe(400);
 expect(fetcher).not.toHaveBeenCalled();
 expect((await createOpenAILiveSession({OPENAI_API_KEY:'secret'},{sdp:'v=0'},fetcher)).body).toEqual({error:'openai_live_session_failed'});
 expect(fetcher).toHaveBeenCalledOnce();
});
