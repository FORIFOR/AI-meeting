import {readdir,readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), dist=path.join(repo,'apps/web/dist-oss');
const files=[];async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else files.push(file);}}
await walk(dist);
const forbiddenAssets=files.map(f=>path.relative(dist,f)).filter(f=>/^(vendor|avatar-fallbacks)\//.test(f)||/^characters\/(?!(?:vrm-sample|vroid-b)\/)/.test(f)||/meeting-credit|cloud-costs/.test(f));
const packages=new Map(),forbiddenSources=[];
const missingSourceMaps=[],invalidSourceMaps=[],unresolvedPackages=[],verifiedWorkerArtifacts=[],failedPackages=new Set();
const runtimeFiles=files.filter(file=>/\.(?:js|mjs|cjs)$/.test(file)), fileSet=new Set(files);
// The dependency inventory is only meaningful when every shipped script has its map.
if(!runtimeFiles.length)missingSourceMaps.push({file:null,reason:'No runtime JavaScript found'});
for(const file of runtimeFiles){
  const text=await readFile(file,'utf8');
  const reference=[...text.matchAll(/^\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/gm)].at(-1)?.[1];
  const resolved=reference ? path.resolve(path.dirname(file),reference) : null;
  const relative=resolved ? path.relative(dist,resolved) : null;
  if(!reference || !reference.endsWith('.map') || /^[a-z]+:|^\/\//i.test(reference) || relative?.startsWith('..') || !fileSet.has(resolved)){
    missingSourceMaps.push({file:path.relative(dist,file),reference:reference??null,reason:'A local, shipped source map is required'});
  }
}
for(const file of files.filter(f=>f.endsWith('.map'))){
  let map;
  try{
    map=JSON.parse(await readFile(file,'utf8'));
    if(!map || map.version!==3 || 'sections' in map || (map.sourceRoot!==undefined && map.sourceRoot!=='') ||
        !Array.isArray(map.sources) || !map.sources.length || !map.sources.every(source=>typeof source==='string' && source.length>0) ||
        !Array.isArray(map.names) || !map.names.every(name=>typeof name==='string') || typeof map.mappings!=='string'){
      throw new Error('Expected a nonempty version 3 flat source map without sourceRoot');
    }
  }catch(error){invalidSourceMaps.push({file:path.relative(dist,file),reason:String(error.message)});continue;}
  for(const source of map.sources){
    if(/@anam-ai|avatar-providers\/live2d|pixi-live2d|@heygen|avatar-providers\/(liveavatar|tavus)/.test(source))forbiddenSources.push(source);
    const match=/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(source);
    if(!match){
      if(source.includes('node_modules/'))unresolvedPackages.push({source,reason:'Unrecognized package source path'});
      continue;
    }
    const dir=path.resolve(path.dirname(file),match[1]);
    if(packages.has(dir) || failedPackages.has(dir))continue;
    try{
      const json=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));
      if(typeof json.name!=='string' || !json.name || typeof json.version!=='string' || !json.version)throw new Error('Missing package name/version');
      packages.set(dir,json);
    }catch(error){
      // Vite 7 emits this worker map one directory shallower than its final assets/ path.
      // Accept only the known wLipSync WASM URL module, after matching the shipped binary.
      const worker=/^wlipsync\.worker-.*\.js\.map$/.test(path.basename(file)) &&
        /^\.\.\/\.\.\/\.\.\/(node_modules\/\.pnpm\/wlipsync@[^/]+\/node_modules\/wlipsync)\/dist\/wlipsync\.wasm\?url$/.exec(source);
      let verified=false;
      if(worker){
        try{
          const workerDir=path.join(repo,worker[1]);
          const pkg=JSON.parse(await readFile(path.join(workerDir,'package.json'),'utf8'));
          const wasm=await readFile(path.join(workerDir,'dist/wlipsync.wasm'));
          const emitted=files.filter(file=>/^wlipsync-[^/]+\.wasm$/.test(path.basename(file)));
          if(pkg.name==='wlipsync' && typeof pkg.version==='string' && emitted.length===1 && wasm.equals(await readFile(emitted[0]))){
            packages.set(workerDir,pkg);verifiedWorkerArtifacts.push({source,artifact:path.relative(dist,emitted[0]),package:`${pkg.name}@${pkg.version}`,sha256:createHash('sha256').update(wasm).digest('hex')});verified=true;
          }
        }catch{/* Report the original resolution failure unless the complete artifact check succeeds. */}
      }
      failedPackages.add(dir);
      if(!verified)unresolvedPackages.push({source,reason:String(error.message)});
    }
  }
}
// WASM and imported CSS are not represented by JavaScript source maps.
for(const sub of ['avatar-providers/vrm/node_modules/wlipsync','apps/web/node_modules/@digital-go-jp/design-tokens']){const dir=path.join(repo,sub);packages.set(dir,JSON.parse(await readFile(path.join(dir,'package.json'),'utf8')));}
const notices=[],missing=[],verifiedSupplements=[];
const sha256=data=>createHash('sha256').update(data).digest('hex');
for(const [dir,pkg] of packages){
  const candidates=(await readdir(dir)).filter(x=>/^(licen[sc]e|copying|notice)(\.|$)/i.test(x));
  const texts=[];
  for(const name of candidates){const file=path.join(dir,name);if((await stat(file)).isFile())texts.push(`### ${name}\n\n${await readFile(file,'utf8')}`);}
  if(!texts.length && pkg.name==='@mediapipe/tasks-vision' && pkg.version==='1.0.1'){
    const source=JSON.parse(await readFile(path.join(repo,'vendor/licenses/tasks-vision-SOURCE.json'),'utf8'));
    const supplement=await readFile(path.join(repo,'vendor/licenses/tasks-vision-LICENSE.txt'));
    if(source.package.name!==pkg.name || source.package.version!==pkg.version || sha256(supplement)!==source.supplement.sha256)throw new Error('MediaPipe license supplement differs from its verified provenance');
    for(const expected of source.artifact.installedFilesMatchedToTarball){
      if(sha256(await readFile(path.join(dir,expected.path)))!==expected.sha256)throw new Error(`MediaPipe artifact changed: ${expected.path}; repeat the license audit`);
    }
    texts.push(supplement.toString('utf8'));
    await writeFile(path.join(dist,'tasks-vision-SOURCE.json'),JSON.stringify(source,null,2)+'\n');
    verifiedSupplements.push(`${pkg.name}@${pkg.version}`);
  }
  if(!texts.length)missing.push(`${pkg.name}@${pkg.version}`);else notices.push(`## ${pkg.name}@${pkg.version}\n\n${texts.join('\n\n')}`);
}
await writeFile(path.join(dist,'THIRD_PARTY_LICENSES.txt'),'Third-party runtime licenses extracted from the actual OSS bundle source maps.\nModels have separate conditions in characters/vroid-b/LICENSE.md and characters/vrm-sample/LICENSE.md.\n\n'+notices.sort().join('\n\n'));
const modelHashes = await Promise.all(['vrm-sample','vroid-b'].map(async id => { const source=JSON.parse(await readFile(path.join(dist,`characters/${id}/SOURCE.json`),'utf8')); const actual=createHash('sha256').update(await readFile(path.join(dist,`characters/${id}/model.vrm`))).digest('hex'); return {id, sha256:actual, matched:source.sha256===actual}; }));
const html=await readFile(path.join(dist,'index.html'),'utf8');
const rootPackage=JSON.parse(await readFile(path.join(repo,'package.json'),'utf8'));
let applicationLicenseText=null;
try{applicationLicenseText=await readFile(path.join(repo,'LICENSE'));}catch(error){if(error.code!=='ENOENT')throw error;}
let applicationNoticeText=null;
try{applicationNoticeText=await readFile(path.join(repo,'NOTICE'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(applicationLicenseText)await writeFile(path.join(dist,'LICENSE'),applicationLicenseText);
if(applicationNoticeText)await writeFile(path.join(dist,'NOTICE'),applicationNoticeText);
const applicationLicense={
  declared:rootPackage.license??null,file:applicationLicenseText?'LICENSE':null,
  sha256:applicationLicenseText?sha256(applicationLicenseText):null,
  notice:applicationNoticeText?'NOTICE':null,
  // Compare with the exact official Apache 2.0 text, not merely a heading or metadata claim.
  verified:rootPackage.license==='Apache-2.0' && applicationLicenseText!==null && sha256(applicationLicenseText)==='cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  scope:'Application-specific source code and documentation only; third-party rights and service contracts remain separate.',
};
const licenseExceptions=[
  {path:'characters/vroid-b/model.vrm',license:'VRM Public License 1.0 and VRoid sample model conditions',notice:'characters/vroid-b/LICENSE.md'},
  {path:'characters/vrm-sample/model.vrm',license:'VRM Public License 1.0 and embedded model permissions',notice:'characters/vrm-sample/LICENSE.md'},
  {path:'avatar-providers/vrm/src/wlipsync-profile.json',license:'MIT',notice:'avatar-providers/vrm/src/wlipsync-profile.LICENSE'},
  {path:'runtime dependencies',license:'Per-package upstream licenses',notice:'THIRD_PARTY_LICENSES.txt'},
  {path:'characters/sora/model.glb',distribution:'source tree only; excluded from OSS browser assets',license:'CC0-1.0',notice:'characters/sora/LICENSE.md'},
  {path:'scripts/reality/attendee-selfhost/local-patches.diff',distribution:'source tree only',license:'Elastic-2.0 for upstream material',notice:'scripts/reality/attendee-selfhost/LICENSE.upstream'},
  {path:'optional Live2D assets and hosted services',distribution:'excluded from OSS browser build',license:'Separate component, model and service terms',notice:'NOTICE.md'},
];
const result={at:new Date().toISOString(),files:files.length,runtimePackages:[...new Set([...packages.values()].map(p=>`${p.name}@${p.version}`))].sort(),forbiddenAssets,forbiddenSources:[...new Set(forbiddenSources)],missingSourceMaps,invalidSourceMaps,unresolvedPackages,verifiedWorkerArtifacts,missingLicenseTexts:missing,verifiedSupplements,externalFontLinks:/<link[^>]*href="https?:\/\//.test(html),modelHashes,vrmHashMatched:modelHashes.every(model=>model.matched),avatarApiRequired:false,applicationLicense,licenseExceptions,rootCodeLicenseFinalized:applicationLicense.verified};
await writeFile(path.join(dist,'OSS-BUILD-AUDIT.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(forbiddenAssets.length||forbiddenSources.length||missingSourceMaps.length||invalidSourceMaps.length||unresolvedPackages.length||missing.length||result.externalFontLinks||!result.vrmHashMatched||!applicationLicense.verified)process.exitCode=1;
