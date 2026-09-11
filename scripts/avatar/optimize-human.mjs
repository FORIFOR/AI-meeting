import puppeteer from '../../apps/web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:5185/');
 const data=await page.evaluate(async root=>{
  const {GLTFLoader}=await import(`/@fs${root}/avatar-providers/vrm/node_modules/three/examples/jsm/loaders/GLTFLoader.js`);
  const {GLTFExporter}=await import(`/@fs${root}/avatar-providers/vrm/node_modules/three/examples/jsm/exporters/GLTFExporter.js`);
  const {humanFaceWeights}=await import(`/@fs${root}/avatar-providers/vrm/src/HumanGLBAvatarProvider.ts`);
  const {neutralParams}=await import(`/@fs${root}/packages/avatar-core/src/index.ts`);
  const supported=new Set(Object.keys(humanFaceWeights(neutralParams())));
  const gltf=await new GLTFLoader().loadAsync('/characters/sora/model.glb');
  gltf.scene.traverse(mesh=>{
   if(!mesh.morphTargetDictionary)return;
   const entries=Object.entries(mesh.morphTargetDictionary).filter(([name])=>supported.has(name));
   for(const key of Object.keys(mesh.geometry.morphAttributes)) mesh.geometry.morphAttributes[key]=entries.map(([,index])=>mesh.geometry.morphAttributes[key][index]);
   mesh.morphTargetInfluences=entries.map(()=>0);mesh.morphTargetDictionary=Object.fromEntries(entries.map(([name],index)=>[name,index]));
  });
  const glb=await new GLTFExporter().parseAsync(gltf.scene,{binary:true,maxTextureSize:1024});
  let text='';for(const b of new Uint8Array(glb))text+=String.fromCharCode(b);return btoa(text);
 },root);
 await writeFile(`${root}/characters/sora/model.glb`,Buffer.from(data,'base64'));
 console.log('Wrote model with only runtime-supported facial targets');
}finally{await browser.close();}
