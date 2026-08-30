import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import { MotionStackAvatarBase, type AvatarParams, type CharacterDefinition, type MotionStackAvatarOptions } from "@rcai/avatar-core";
import { mapParamsToVRM, type Euler3, type VRMPose } from "./mapping.js";

export interface VRMAvatarOptions extends MotionStackAvatarOptions {
  container: HTMLElement;
  /** Override the model URL (otherwise `${character.baseUrl}/${character.model}`). */
  modelUrl?: string;
  /** CSS colour or null for transparent. Default transparent. */
  background?: string | null;
  /** Camera distance from the head (m). Default 1.1. */
  cameraDistance?: number;
}

const BONES: (keyof VRMPose & VRMHumanBoneName)[] = [
  "head", "neck", "spine", "chest", "upperChest",
  "leftShoulder", "rightShoulder", "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm", "leftHand", "rightHand",
];

/**
 * VRM 3D AvatarProvider (spec §16): three + @pixiv/three-vrm.
 * Humanoid bones ← head/body/arm params, ExpressionManager ← blink/emotion/visemes,
 * LookAt ← eyeBall params, SpringBone ← vrm.update(). Motion selection/composition is inherited
 * from MotionStackAvatarBase, so this file only maps and renders.
 */
export class VRMAvatarProvider extends MotionStackAvatarBase {
  readonly id = "vrm";
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera | null = null;
  private vrm: VRM | null = null;
  private lookAtTarget = new THREE.Object3D();
  private headWorld = new THREE.Vector3(0, 1.4, 0);
  private resizeObserver: ResizeObserver | null = null;
  private lastPose: VRMPose | null = null;

  constructor(private readonly vrmOpts: VRMAvatarOptions) {
    super(vrmOpts);
  }

  protected async loadModel(character: CharacterDefinition): Promise<void> {
    const url = this.vrmOpts.modelUrl ?? `${character.baseUrl}/${character.model}`;
    const container = this.vrmOpts.container;
    const width = container.clientWidth || 640;
    const height = container.clientHeight || 480;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(typeof devicePixelRatio === "number" ? Math.min(devicePixelRatio, 2) : 1);
    this.renderer.setSize(width, height);
    if (this.vrmOpts.background) this.renderer.setClearColor(new THREE.Color(this.vrmOpts.background), 1);
    else this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 20);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.6);
    key.position.set(1, 2, 2);
    this.scene.add(key);
    this.scene.add(this.lookAtTarget);

    const loader = new GLTFLoader();
    loader.crossOrigin = "anonymous";
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.combineMorphs(vrm);
    VRMUtils.rotateVRM0(vrm); // VRM0 faces -Z; normalise to +Z (toward the viewer)
    vrm.scene.traverse((o) => (o.frustumCulled = false));
    this.scene.add(vrm.scene);
    this.vrm = vrm;

    if (vrm.lookAt) vrm.lookAt.target = this.lookAtTarget;

    // Drop the arms from T-pose immediately so the first frame is not a scarecrow.
    const headNode = vrm.humanoid.getNormalizedBoneNode("head");
    if (headNode) headNode.getWorldPosition(this.headWorld);
    else this.headWorld.set(0, 1.4, 0);
    const dist = this.vrmOpts.cameraDistance ?? 1.1;
    this.camera.position.set(0, this.headWorld.y - 0.1, this.headWorld.z + dist);
    this.camera.lookAt(0, this.headWorld.y - 0.15, this.headWorld.z);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.applyParams(this.stack.compose(this.clock(), 16), 16);
  }

  private resize(): void {
    if (!this.renderer || !this.camera) return;
    const w = this.vrmOpts.container.clientWidth || 1;
    const h = this.vrmOpts.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  protected applyParams(params: AvatarParams, dtMs: number): void {
    const vrm = this.vrm;
    if (!vrm || !this.renderer || !this.camera) return;
    const pose = mapParamsToVRM(params);
    this.lastPose = pose;

    for (const name of BONES) {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (!node) continue;
      const e = pose[name] as Euler3;
      node.rotation.set(e.x, e.y, e.z);
    }
    const chest = vrm.humanoid.getNormalizedBoneNode("upperChest") ?? vrm.humanoid.getNormalizedBoneNode("chest");
    if (chest) chest.scale.setScalar(pose.breathScale);

    const em = vrm.expressionManager;
    if (em) {
      for (const [name, value] of Object.entries(pose.expressions)) {
        if (em.getExpression(name)) em.setValue(name, value);
      }
    }

    this.lookAtTarget.position.set(this.headWorld.x + pose.lookAt.x, this.headWorld.y + pose.lookAt.y, this.headWorld.z + pose.lookAt.z);

    vrm.update(dtMs / 1000);
    this.renderer.render(this.scene, this.camera);
  }

  /** Last mapped pose (debug / tests). */
  getPose(): VRMPose | null {
    return this.lastPose;
  }

  protected async disposeModel(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
  }
}
