/** Bound optional rendering work; a provider returning after cancellation never becomes active. */
export const AVATAR_STEP_TIMEOUT_MS = 15_000;
export function awaitAvatarStep<T>(operation: Promise<T>, signal: AbortSignal, dispose: (value?: T) => Promise<void>, timeoutMs = AVATAR_STEP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false, abandoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = (value?: T) => { void Promise.resolve().then(() => dispose(value)).catch(() => {}); };
    const finish = () => { settled=true; if(timer)clearTimeout(timer);signal.removeEventListener('abort', abort); };
    const abort = () => { if(settled)return;abandoned=true;finish();release();reject(new Error('avatar work cancelled')); };
    operation.then(value => {
      if(abandoned) { release(value);return; }
      if(settled)return;finish();resolve(value);
    }, error => { if(!settled){finish();reject(error);} });
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{if(settled)return;abandoned=true;finish();release();reject(new Error('avatar preparation timed out'));},timeoutMs);
  });
}
