import { mkdir, writeFile, cp, readFile, readdir } from 'node:fs/promises';
import { createHash, } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));process.chdir(root);const out=path.join(root,'apps/desktop/src-tauri/resources/local-runtime');
const arch=process.arch;if(process.platform!=='darwin'||!['arm64','x64'].includes(arch))throw Error('macOS arm64/x64 build required');
await mkdir(out,{recursive:true});
async function archive(url,sha,file){const dest=path.join(out,file);let bytes;try{bytes=await readFile(dest);}catch{}if(!bytes||createHash('sha256').update(bytes).digest('hex')!==sha){const r=await fetch(url);if(!r.ok)throw Error(`Download ${r.status}: ${url}`);bytes=Buffer.from(await r.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==sha)throw Error('Checksum mismatch');await writeFile(dest,bytes);}execFileSync('/usr/bin/tar',['-xzf',dest,'-C',out]);}
const nodeVersion='v22.23.2';const nodeFile=`node-${nodeVersion}-darwin-${arch}.tar.gz`;
const sums=await(await fetch(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`)).text();const nodeHash=sums.split('\n').find(l=>l.endsWith('  '+nodeFile))?.split(' ')[0];if(!nodeHash)throw Error('Missing Node checksum');
await archive(`https://nodejs.org/dist/${nodeVersion}/${nodeFile}`,nodeHash,nodeFile);
const llamaFile=`llama-b10858-bin-macos-${arch==='x64'?'x64':'arm64'}.tar.gz`;
await archive(`https://github.com/ggml-org/llama.cpp/releases/download/b10858/${llamaFile}`,arch==='arm64'?'69a0cbd23a9eb9085752f87ab3ae75198755e6a9c47752b193495ae8f3bea70d':'8664bb4589bf8080bcbb7764869739228b6284c0e45ef72690450b5e134fc0e3',llamaFile);
const {build}=await import('../node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js');
await build({entryPoints:['services/agent/src/server.ts'],outfile:path.join(out,'server.js'),bundle:true,platform:'node',format:'esm',target:'node22',external:['sherpa-onnx-node','onnxruntime-node','@huggingface/transformers'],banner:{js:'import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);'}});
await writeFile(path.join(out,'package.json'),JSON.stringify({type:'module'}));
const req=createRequire(path.join(root,'services/agent/package.json'));
for(const name of ['sherpa-onnx-node',`sherpa-onnx-darwin-${arch}`]){const packageFile=name==='sherpa-onnx-node'?req.resolve(name+'/package.json'):createRequire(req.resolve('sherpa-onnx-node/package.json')).resolve(name+'/package.json');await cp(path.dirname(packageFile),path.join(out,'node_modules',name),{recursive:true,dereference:true});}
await cp('apps/desktop/local-runtime',out,{recursive:true,filter:src=>!src.endsWith('.test.mjs')});
// Keep only runtime files. Archives and Node documentation do not belong in the installed app.
const {rm}=await import('node:fs/promises');for(const name of await readdir(out)){if(name.endsWith('.tar.gz'))await rm(path.join(out,name));}
await writeFile(path.join(out,'runtime.json'),JSON.stringify({arch,node:`node-${nodeVersion}-darwin-${arch}/bin/node`}));
for (const name of await readdir(out)) {
 if(name.startsWith('node-v') && name!==`node-${nodeVersion}-darwin-${arch}`) await rm(path.join(out,name),{recursive:true,force:true});
}
// Only the Node executable is needed; no user-facing npm installation or build tools.
for(const name of await readdir(path.join(out,`node-${nodeVersion}-darwin-${arch}`))) if(name!=='bin'&&name!=='LICENSE') await rm(path.join(out,`node-${nodeVersion}-darwin-${arch}`,name),{recursive:true,force:true});
for(const name of await readdir(path.join(out,`node-${nodeVersion}-darwin-${arch}/bin`))) if(name!=='node') await rm(path.join(out,`node-${nodeVersion}-darwin-${arch}/bin`,name),{force:true});
const llamaDir=path.join(out,'llama-b10858');
for(const name of await readdir(llamaDir)) if(name!=='llama-server'&&!name.endsWith('.dylib')&&name!=='LICENSE') await rm(path.join(llamaDir,name),{recursive:true,force:true});
if(process.env.APPLE_SIGNING_IDENTITY){
 async function signTree(dir){for(const e of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())await signTree(file);else if(e.isFile()&&execFileSync('/usr/bin/file',['-b',file],{encoding:'utf8'}).includes('Mach-O')){execFileSync('/usr/bin/codesign',['--force','--timestamp','--options','runtime','--sign',process.env.APPLE_SIGNING_IDENTITY,...(e.name==='node'?['--entitlements',path.join(out,'node-entitlements.plist')]:[]),file]);}}}
 await signTree(out);
}
console.log('Local runtime prepared:',out);
