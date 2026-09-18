// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {authorizeCalendar} from './googleCalendar.js';
let callback:(r:any)=>void;
function setup(){vi.stubGlobal('google',{accounts:{oauth2:{hasGrantedAllScopes:()=>true,initTokenClient:(c:any)=>{callback=c.callback;return {requestAccessToken:vi.fn()};}}}});const request=vi.fn(async()=>new Response(JSON.stringify({sub:'owner',email:'owner@example.test'})));vi.stubGlobal('fetch',request);return request;}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('ignores OAuth callbacks arriving after timeout rather than fetching the user account',async()=>{
 vi.useFakeTimers();const request=setup(),p=authorizeCalendar('client',true);const rejected=expect(p).rejects.toThrow();await vi.advanceTimersByTimeAsync(120001);await rejected;
 callback({access_token:'late-token',expires_in:3600});expect(request).not.toHaveBeenCalled();
});
it('cancels in-flight authorization on navigation or privacy mode changes',async()=>{
 const request=setup(),abort=new AbortController(),p=authorizeCalendar('client',true,abort.signal);const rejected=expect(p).rejects.toThrow();abort.abort();await rejected;
 callback({access_token:'late-token',expires_in:3600});expect(request).not.toHaveBeenCalled();
});
it('does not accept duplicate callbacks as a second account authorization',async()=>{
 const request=setup(),p=authorizeCalendar('client',true);callback({access_token:'first-token',expires_in:3600});callback({access_token:'second-token',expires_in:3600});
 expect((await p).token).toBe('first-token');expect(request).toHaveBeenCalledOnce();
});
