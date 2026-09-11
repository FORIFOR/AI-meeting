import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import { MotionStackAvatarBase, type AvatarParams, type AvatarState, type CharacterDefinition, type MotionStackAvatarOptions } from "@rcai/avatar-core";
import { mapParamsToVRM, type Euler3, type VRMPose } from "./mapping.js";
import { WLipSyncEngine } from "./WLipSyncEngine.js";

export interface VRMAvatarOptions extends MotionStackAvatarOptions {
  container: HTMLElement;
  /** Override the model URL (otherwise `${character.baseUrl}/${character.model}`). */
  modelUrl?: string;
  /** CSS colour or null for transparent. Default transparent. */
  background?: string | null;
  /** Camera distance from the head (m). Default 1.45, leaving headroom in portrait previews. */
  cameraDistance?: number;
  /** Reject remote model URLs and referenced resources before transmission in strict_local. */
  privacyMode?: "default" | "strict_local";
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
  private loadGeneration = 0;
  private modelRequest: AbortController | null = null;
  private loadingManager: THREE.LoadingManager | null = null;
  private modelResourceURLs: Set<string> | null = null;
  private readonly wasmLipSync: WLipSyncEngine | null;
  private renderedFrames = 0;
  private renderLoopRunning = false;

  constructor(private readonly vrmOpts: VRMAvatarOptions) {
    super(vrmOpts);
    this.wasmLipSync = vrmOpts.lipSync ? null : new WLipSyncEngine({ clock: this.clock });
    if (this.wasmLipSync) this.lipSync = this.wasmLipSync;
  }

  protected async loadModel(character: CharacterDefinition): Promise<void> {
    const generation = ++this.loadGeneration;
    this.releaseModel();
    const url = this.vrmOpts.modelUrl ?? `${character.baseUrl}/${character.model}`;
    this.assertModelURL(url);
    const abort = new AbortController();
    this.modelRequest = abort;
    const manager = new THREE.LoadingManager();
    const ownedURLs = new Set<string>();
    const suppliedURLs = new Set<string>();
    this.modelResourceURLs = ownedURLs;
    const resourceURL = (value: string) => new URL(value, this.vrmOpts.container.ownerDocument.baseURI);
    const revokeOwnedURLs = () => {
      for (const value of ownedURLs) URL.revokeObjectURL(value);
      ownedURLs.clear();
    };
    let resourceFailed = false;
    // GLTFLoader deliberately converts texture errors to null and can resolve with a white
    // model. Treat a failed/blocked dependency as preparation failure so the owner can fall back.
    manager.onError = () => { resourceFailed = true; };
    manager.setURLModifier((resource) => {
      const resolved = resourceURL(resource);
      // Declared blob URIs belong to the caller. Other blob URIs are GLTFLoader's
      // temporary images created from this model's bufferViews.
      if (resolved.protocol === "blob:" && !suppliedURLs.has(resolved.href)) ownedURLs.add(resolved.href);
      try {
        if (!current()) {
          revokeOwnedURLs();
          throw new Error("VRM_MODEL_LOAD_CANCELLED");
        }
        this.assertModelURL(resource);
        return resource;
      }
      catch (error) { resourceFailed = true; throw error; }
    });
    this.loadingManager = manager;
    const current = () => generation === this.loadGeneration && !abort.signal.aborted;
    const container = this.vrmOpts.container;
    const width = container.clientWidth || 640;
    const height = container.clientHeight || 480;

    try {
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

      this.wasmLipSync?.start();
      const loader = new GLTFLoader(manager);
      loader.crossOrigin = "anonymous";
      loader.register((parser) => {
        // Run before GLTF starts loading any dependent buffers/textures. Even same-origin
        // URI references can redirect outside the device in the vendor's default fetch path.
        // Strict-local imports therefore require embedded bufferViews or data URIs only.
        for (const entries of [parser.json.images, parser.json.buffers]) {
          for (const entry of entries ?? []) {
            if (typeof entry.uri !== "string") continue;
            const resolved = resourceURL(entry.uri);
            if (this.vrmOpts.privacyMode === "strict_local" && resolved.protocol !== "data:") {
              throw new Error("VRM_SELF_CONTAINED_MODEL_REQUIRED");
            }
            if (resolved.protocol === "blob:") suppliedURLs.add(resolved.href);
          }
        }
        return new VRMLoaderPlugin(parser);
      });
      // Fetch owns cancellation; parsing may finish after stop, and must then dispose its model.
      const response = await fetch(url, { signal: abort.signal,
        redirect: this.vrmOpts.privacyMode === "strict_local" ? "error" : "follow" });
      if (!response.ok) throw new Error(`VRM_MODEL_LOAD_FAILED:${response.status}`);
      const bytes = await response.arrayBuffer();
      if (!current()) throw new Error("VRM_MODEL_LOAD_CANCELLED");
      const baseURL = url.slice(0, url.lastIndexOf("/") + 1);
      const gltf = await loader.parseAsync(bytes, baseURL);
      if (!current()) {
        VRMUtils.deepDispose(gltf.scene);
        throw new Error("VRM_MODEL_LOAD_CANCELLED");
      }
      if (resourceFailed) {
        VRMUtils.deepDispose(gltf.scene);
        throw new Error("VRM_MODEL_RESOURCE_FAILED");
      }
      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) {
        VRMUtils.deepDispose(gltf.scene);
        throw new Error("VRM_MODEL_INVALID");
      }
      // Own the scene before optimization so an optimizer failure also releases GPU assets.
      this.vrm = vrm;
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.combineMorphs(vrm);
      VRMUtils.rotateVRM0(vrm); // VRM0 faces -Z; normalise to +Z (toward the viewer)
      vrm.scene.traverse((o) => (o.frustumCulled = false));
      this.scene.add(vrm.scene);

      if (vrm.lookAt) vrm.lookAt.target = this.lookAtTarget;

      // Drop the arms from T-pose immediately so the first frame is not a scarecrow.
      const headNode = vrm.humanoid.getNormalizedBoneNode("head");
      if (headNode) headNode.getWorldPosition(this.headWorld);
      else this.headWorld.set(0, 1.4, 0);
      const dist = this.vrmOpts.cameraDistance ?? 1.45;
      this.camera.position.set(0, this.headWorld.y - 0.1, this.headWorld.z + dist);
      this.camera.lookAt(0, this.headWorld.y - 0.15, this.headWorld.z);

      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(container);
      }
      this.applyParams(this.stack.compose(this.clock(), 16), 16);
    } catch (error) {
      if (generation === this.loadGeneration) this.releaseModel();
      throw error;
    } finally {
      // three revokes its generated image URLs on success, but omits that cleanup on
      // texture failure. Repeated revoke is harmless and never touches caller-owned URLs.
      revokeOwnedURLs();
    }
  }

  private assertModelURL(url: string): void {
    if (this.vrmOpts.privacyMode !== "strict_local") return;
    const base = this.vrmOpts.container.ownerDocument.baseURI;
    const resolved = new URL(url, base);
    if (resolved.protocol === "data:") return;
    if (resolved.origin !== new URL(base).origin || !["http:", "https:", "blob:"].includes(resolved.protocol)) {
      throw new Error("VRM_REMOTE_ASSET_BLOCKED_BY_PRIVACY");
    }
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
    if (this.wasmLipSync && this.stack.isSpeaking) {
      const { visemes } = this.wasmLipSync.sample();
      pose.expressions.aa = visemes.a;
      pose.expressions.ih = visemes.i;
      pose.expressions.ou = visemes.u;
      pose.expressions.ee = visemes.e;
      pose.expressions.oh = visemes.o;
    }
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
    this.renderedFrames++;
  }

  /** Last mapped pose (debug / tests). */
  getPose(): VRMPose | null {
    return this.lastPose;
  }

  override setState(state: AvatarState, force = false): void {
    if (state !== this.state && (this.state === "SPEAKING" || state === "SPEAKING")) this.lipSync.reset();
    super.setState(state, force);
  }

  override async start(): Promise<void> {
    await super.start();
    this.renderLoopRunning = true;
  }

  override async stop(): Promise<void> {
    this.renderLoopRunning = false;
    await super.stop();
  }

  /** Records the requested analysis and the engine actually supplying current visemes. */
  getLipSyncDiagnostics(): { requested: string; actual: string; state: string } {
    return this.wasmLipSync?.getDiagnostics() ?? { requested: "custom", actual: "custom", state: "ready" };
  }

  /** Read-only renderer counters for soak checks; no WebGL allocation or scene mutation. */
  getRenderDiagnostics(): { renderedFrames: number; geometries: number; textures: number; programs: number; contextLost: boolean; running: boolean } {
    const renderer = this.renderer;
    return {
      renderedFrames: this.renderedFrames,
      geometries: renderer?.info.memory.geometries ?? 0,
      textures: renderer?.info.memory.textures ?? 0,
      programs: renderer?.info.programs?.length ?? 0,
      contextLost: renderer?.getContext().isContextLost() ?? false,
      running: this.renderLoopRunning && renderer !== null && this.vrm !== null,
    };
  }

  protected async disposeModel(): Promise<void> {
    ++this.loadGeneration;
    this.interrupt();
    this.releaseModel();
  }

  private releaseModel(): void {
    this.modelRequest?.abort();
    this.modelRequest = null;
    this.loadingManager?.abort();
    this.loadingManager = null;
    for (const value of this.modelResourceURLs ?? []) URL.revokeObjectURL(value);
    this.modelResourceURLs?.clear();
    this.modelResourceURLs = null;
    this.wasmLipSync?.dispose();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.camera = null;
    this.lastPose = null;
    this.scene.clear();
  }
}
