// Renderer fixture test; the sphere is a synthetic rig, not a shipped character.
import puppeteer from '../../apps/web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage();await page.setViewport({width:1280,height:720});await page.goto('http://127.0.0.1:5185/');
 const result=await page.evaluate(async root=>{
  const THREE=await import('/node_modules/.vite/deps/three.js');
  const {HumanGLBAvatarProvider}=await import(`/@fs${root}/avatar-providers/vrm/src/HumanGLBAvatarProvider.ts`);
  const {GLTFExporter}=await import(`/@fs${root}/avatar-providers/vrm/node_modules/three/examples/jsm/exporters/GLTFExporter.js`);
  const geometry=new THREE.SphereGeometry(1,16,16);
  const morph=geometry.attributes.position.clone();for(let i=0;i<morph.count;i++) morph.setY(i,morph.getY(i)*1.2);
  geometry.morphAttributes.position=[morph];
  const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:'#d5a899'}));mesh.morphTargetDictionary={jawOpen:0};
  const glb=await new GLTFExporter().parseAsync(mesh,{binary:true});
  const url=URL.createObjectURL(new Blob([glb],{type:'model/gltf-binary'}));
  document.body.innerHTML='<div id="stage" style="position:fixed;inset:0"></div>';
  const avatar=new HumanGLBAvatarProvider({container:document.querySelector('#stage')});
  const character={baseUrl:'',model:url,manifest:{id:'fixture',name:'Fixture',renderer:'human-glb'},motions:{},expressions:{}};
  try {
   await avatar.prepare(character);await avatar.start();avatar.setState('SPEAKING');
   avatar.pushAudio({data:new Float32Array(960).fill(0.2),sampleRate:48000,timestamp:performance.now(),channels:1});
   await new Promise(r=>setTimeout(r,80));
   const meshes=avatar.faces.length;avatar.interrupt();await avatar.stop();
   return {meshes,canvasRemoved:!document.querySelector('#stage canvas')};
  } finally {URL.revokeObjectURL(url);}
 },root);
 console.log(JSON.stringify(result));if(!result.meshes||!result.canvasRemoved)throw new Error('GLB lifecycle failed');
}finally{await browser.close();}
