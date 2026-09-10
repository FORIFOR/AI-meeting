import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MotionStackAvatarBase, type AvatarParams, type CharacterDefinition, type MotionStackAvatarOptions } from "@rcai/avatar-core";

export function humanFaceWeights(p: AvatarParams): Record<string, number> {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return {
    jawOpen: clamp(p.mouthOpenY), mouthSmileLeft: clamp(p.mouthForm), mouthSmileRight: clamp(p.mouthForm),
    mouthFrownLeft: clamp(-p.mouthForm), mouthFrownRight: clamp(-p.mouthForm),
    eyeBlinkLeft: clamp(1 - p.eyeLOpen), eyeBlinkRight: clamp(1 - p.eyeROpen),
    browInnerUp: clamp((p.browLY + p.browRY) / 2),
    eyeLookOutLeft: clamp(-p.eyeBallX), eyeLookInLeft: clamp(p.eyeBallX),
    eyeLookOutRight: clamp(p.eyeBallX), eyeLookInRight: clamp(-p.eyeBallX),
    eyeLookUpLeft: clamp(p.eyeBallY), eyeLookUpRight: clamp(p.eyeBallY),
    eyeLookDownLeft: clamp(-p.eyeBallY), eyeLookDownRight: clamp(-p.eyeBallY),
    viseme_aa: clamp(p.mouthOpenY),
  };
}

/** A self-contained GLB with ARKit jawOpen or Oculus viseme_aa. No cloud animation service. */
export class HumanGLBAvatarProvider extends MotionStackAvatarBase {
  readonly id = "human-glb";
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
  private model: THREE.Group | null = null;
  private faces: THREE.Mesh[] = [];
  private head: THREE.Object3D | null = null;
  private headRest = new THREE.Euler();
  private resizeObserver: ResizeObserver | null = null;
  private elapsed = 0;
  private previousMouth = 0;

  constructor(private readonly opts: MotionStackAvatarOptions & { container: HTMLElement }) { super(opts); }

  protected async loadModel(character: CharacterDefinition): Promise<void> {
    try {
      const modelUrl = /^(blob:|https?:)/.test(character.model) ? character.model : `${character.baseUrl}/${character.model}`;
      const gltf = await new GLTFLoader().loadAsync(modelUrl);
      this.model = gltf.scene;
      gltf.scene.traverse(node => {
        if (node instanceof THREE.Mesh && node.morphTargetDictionary && node.morphTargetInfluences) this.faces.push(node);
        if (/^(head|mixamorighead)$/i.test(node.name)) this.head = node;
      });
      if (!this.faces.some(mesh => mesh.morphTargetDictionary?.jawOpen !== undefined || mesh.morphTargetDictionary?.viseme_aa !== undefined)) {
        throw new Error("BLOCKED_BY_GLB_RIG: model needs jawOpen or viseme_aa facial morph targets");
      }
      if (this.head) this.headRest.copy(this.head.rotation);
      this.scene.add(gltf.scene);
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2));
      const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(2, 3, 4); this.scene.add(key);
      this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
      this.renderer.setClearColor(character.view?.background ?? "#f6f1ea");
      this.renderer.setPixelRatio(1);
      this.opts.container.appendChild(this.renderer.domElement);
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const extent = Math.max(size.x, size.y, size.z, 0.1);
      this.camera.position.set(center.x, center.y, center.z + extent * 2.2);
      this.camera.lookAt(center);
      this.resize();
      this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(this.opts.container);
    } catch (error) { await this.disposeModel(); throw error; }
  }

  private resize(): void {
    const w = Math.max(1, this.opts.container.clientWidth), h = Math.max(1, this.opts.container.clientHeight);
    const scale = Math.min(1, 960 / Math.max(w, h));
    this.renderer?.setSize(Math.round(w * scale), Math.round(h * scale), false);
    if (this.renderer) Object.assign(this.renderer.domElement.style, { width: "100%", height: "100%", display: "block" });
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  protected applyParams(p: AvatarParams, dtMs: number): void {
    const weights = humanFaceWeights(p);
    for (const mesh of this.faces) {
      const dict = mesh.morphTargetDictionary!, values = mesh.morphTargetInfluences!;
      for (const [name, value] of Object.entries(weights)) {
        // Models with both conventions must not open the jaw twice.
        if (name === "viseme_aa" && dict.jawOpen !== undefined) { if(dict[name] !== undefined) values[dict[name]!] = 0; continue; }
        if (dict[name] !== undefined) values[dict[name]!] = value;
      }
    }
    if (this.head) this.head.rotation.set(this.headRest.x + THREE.MathUtils.degToRad(p.angleY), this.headRest.y + THREE.MathUtils.degToRad(p.angleX), this.headRest.z + THREE.MathUtils.degToRad(p.angleZ));
    this.elapsed += dtMs;
    if (this.elapsed >= 1000 / 30 || (p.mouthOpenY === 0 && this.previousMouth > 0)) {
      this.elapsed = 0; this.renderer?.render(this.scene, this.camera);
    }
    this.previousMouth = p.mouthOpenY;
  }

  protected async disposeModel(): Promise<void> {
    this.resizeObserver?.disconnect(); this.resizeObserver = null;
    this.model?.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      node.geometry.dispose();
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
        material.dispose();
      }
    });
    if (this.model) this.scene.remove(this.model);
    this.model = null; this.faces = []; this.head = null;
    this.renderer?.dispose(); this.renderer?.domElement.remove(); this.renderer = null;
    this.scene.clear();
  }
}
