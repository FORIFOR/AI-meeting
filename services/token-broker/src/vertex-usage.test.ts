import { expect, it } from "vitest";
import { VertexUsage } from "./vertex-usage.js";
it("counts PCM actually forwarded and excludes all content from reports",()=>{
 const u=new VertexUsage();u.outbound({realtimeInput:{audio:{data:Buffer.alloc(32000).toString('base64'),mimeType:'audio/pcm;rate=16000'},text:'secret'}});
 u.inbound({usageMetadata:{promptTokenCount:12,totalTokenCount:20,secret:'private'},serverContent:{text:'private'}});
 expect(u.snapshot().sentAudioSeconds).toBe(1);
 expect(u.snapshot().sentTextCharacters).toBe(6);
 expect(JSON.stringify(u.snapshot())).not.toMatch(/secret|private|base64|serverContent/);
});
it("keeps last provider snapshot, never double counts cumulative observations",()=>{
 const u=new VertexUsage();for(const n of [100,100,200])u.inbound({usageMetadata:{promptTokenCount:n}});
 expect(u.snapshot().latestProviderUsage.promptTokenCount).toBe(200);expect(u.snapshot().usageSnapshotCount).toBe(3);
 u.inbound({usageMetadata:{promptTokenCount:-1,totalTokenCount:NaN}});expect(u.snapshot().latestProviderUsage).toEqual({});
});
it("does not invent durations for unknown audio encodings",()=>{
 const u=new VertexUsage();u.outbound({realtimeInput:{audio:{data:'AAAA',mimeType:'audio/mp3'}}});
 expect(u.snapshot().sentAudioSeconds).toBe(0);expect(u.snapshot().unrecognizedAudioChunks).toBe(1);
});
it("measures supported Vertex PCM output with default rate and MIME parameters",()=>{
 const u=new VertexUsage();
 for(const mimeType of ['audio/pcm','audio/pcm;rate=24000;channels=1']) u.inbound({serverContent:{modelTurn:{parts:[{inlineData:{mimeType,data:Buffer.alloc(48000).toString('base64')}}]}}});
 expect(u.snapshot().receivedAudioSeconds).toBe(2);
 u.inbound({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/mp3',data:'AAAA'}}]}}});
 expect(u.snapshot().receivedAudioSeconds).toBe(2);
});
