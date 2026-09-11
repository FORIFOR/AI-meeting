import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {download,recommendedProfile} from './setup.mjs';
test('recommend a model within the supported memory tiers',()=>{assert.equal(recommendedProfile(8),'lite');assert.equal(recommendedProfile(16),'lite');assert.equal(recommendedProfile(24),'standard');});
test('resume, verify, and reuse an intact file; reject corrupt data',async()=>{
 const bytes=Buffer.from('verified model bytes');let requests=0;let range;
 const server=createServer((req,res)=>{requests++;range=req.headers.range;const offset=range?Number(range.match(/\d+/)[0]):0;if(offset){res.statusCode=206;res.setHeader('content-range',`bytes ${offset}-${bytes.length-1}/${bytes.length}`);}res.end(bytes.subarray(offset));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const root=await mkdtemp(path.join(tmpdir(),'rcai-download-'));const file={path:'model',url:`http://127.0.0.1:${server.address().port}`,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
 try{await writeFile(path.join(root,'model.partial'),bytes.subarray(0,5));await download(file,root,new AbortController().signal);assert.equal(range,'bytes=5-');assert.deepEqual(await readFile(path.join(root,'model')),bytes);await download(file,root,new AbortController().signal);assert.equal(requests,1);await rm(path.join(root,'model'));await assert.rejects(download({...file,sha256:'0'.repeat(64)},root,new AbortController().signal),/検証/);await assert.rejects(readFile(path.join(root,'model.partial')));}finally{server.close();await rm(root,{recursive:true,force:true});}
});
test('cancellation retains the partial download for a retry',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'rcai-cancel-'));const controller=new AbortController();
 const server=createServer((req,res)=>{res.write(Buffer.alloc(1024,1));const timer=setInterval(()=>res.write(Buffer.alloc(1024,1)),10);res.on('close',()=>clearInterval(timer));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await assert.rejects(download({path:'model',url:`http://127.0.0.1:${server.address().port}`,sha256:'x',bytes:1024*1024},root,controller.signal,n=>{if(n>=4096)controller.abort();}));assert.ok((await readFile(path.join(root,'model.partial'))).length>0);await assert.rejects(readFile(path.join(root,'model')));}finally{server.close();await rm(root,{recursive:true,force:true});}
});
