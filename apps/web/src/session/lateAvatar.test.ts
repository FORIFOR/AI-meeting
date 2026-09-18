import { afterEach, expect, it, vi } from 'vitest';
import { awaitAvatarStep } from './lateAvatar.js';
afterEach(()=>vi.useRealTimers());
it('times out optional work and disposes a result that eventually returns',async()=>{
 vi.useFakeTimers();let resolve!:(v:string)=>void;const pending=new Promise<string>(r=>resolve=r),dispose=vi.fn(async()=>{});
 const work=awaitAvatarStep(pending,new AbortController().signal,dispose,10);const failed=expect(work).rejects.toThrow('timed out');
 await vi.advanceTimersByTimeAsync(10);await failed;expect(dispose).toHaveBeenCalledOnce();
 resolve('late');await Promise.resolve();await Promise.resolve();expect(dispose).toHaveBeenLastCalledWith('late');expect(vi.getTimerCount()).toBe(0);
});
it('cancels promptly and never exposes an abandoned result',async()=>{
 let resolve!:(v:string)=>void;const pending=new Promise<string>(r=>resolve=r),dispose=vi.fn(async()=>{}),abort=new AbortController();
 const work=awaitAvatarStep(pending,abort.signal,dispose);const failed=expect(work).rejects.toThrow('cancelled');abort.abort();await failed;
 resolve('late');await Promise.resolve();await Promise.resolve();expect(dispose).toHaveBeenLastCalledWith('late');
});
it('keeps successfully acquired work owned by the caller and removes its abort hook',async()=>{
 const abort=new AbortController(),dispose=vi.fn(async()=>{});expect(await awaitAvatarStep(Promise.resolve('ready'),abort.signal,dispose)).toBe('ready');abort.abort();await Promise.resolve();expect(dispose).not.toHaveBeenCalled();
});
