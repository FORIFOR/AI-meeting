import {expect,it} from 'vitest';
// @ts-expect-error JS gate is shared with the CLI
import {assess} from '../../../../scripts/ux/gate.mjs';
it('never passes missing or non-finite measurements',()=>{
 expect(assess({}).status).toBe('NOT_VERIFIED');
 expect(assess({samples:{responseMs:Array(20).fill(NaN)}}).status).toBe('NOT_VERIFIED');
});
it('checks lower-tail FPS and rejects a slow response distribution',()=>{
 const samples=Object.fromEntries(['startupMs','responseMs','interruptionMs','lipSyncOffsetMs','speechDetectionMs'].map(k=>[k,Array(20).fill(10)]));
 const evidence={samples:{...samples,avatarFps:Array(20).fill(60)},incidents:{doubleSpeech:0,stuckSpeaking:0,stuckListening:0}};
 expect(assess(evidence).status).toBe('PASS');evidence.samples.avatarFps[0]=12;expect(assess(evidence).status).toBe('NOT_VERIFIED');
});
