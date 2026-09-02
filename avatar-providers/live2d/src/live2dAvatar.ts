import { AnalyzerLipSync, MotionStackAvatarBase, type AvatarParams, type CharacterDefinition, type Emotion, type MotionStackAvatarOptions, type ParamName } from "@rcai/avatar-core";
import { DEFAULT_VENDOR_MOTIONSYNC_CORE_URL, defaultHeadCheck, loadCubismCore, resolveCoreUrl, type CoreResolution } from "./core.js";
import { buildParamTable, resolveParamIds, toLive2DValues, type ParamTable } from "./mapping.js";
import { MotionSyncLipSync, MotionSyncUnavailableError } from "./motionSync.js";
import type { ParameterModel } from "./motionsync/cubismMotionSync.js";

/** Text colour that reads on a pack's flat background (#rgb / #rrggbb); white on anything else. */
export function inkFor(background: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(background.trim());
  if (!m) return "#ffffff";
  const hex = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma > 0.6 ? "rgba(0, 0, 0, 0.62)" : "#ffffff";
}

export interface Live2DAvatarOptions extends MotionStackAvatarOptions {
  container: HTMLElement;
  /** Explicit Cubism Core URL. Default: vendored file if present, else the official CDN. */
  coreUrl?: string;
  /** false under strict_local: only a vendored Core is allowed (no CDN egress). Default true. */
  allowCdn?: boolean;
  vendorCoreUrl?: string;
  cdnCoreUrl?: string;
  /**
   * "meeting": the page is a camera. The pack's `view.meeting` framing is used, the pack's background is
   * painted flat behind the model, and MSAA is off — inside a vendor's software-GL browser it is the
   * most expensive thing on the page, and invisible after the capture and two encodes between the
   * page and the room. Default "default": the operator's own screen.
   */
  framing?: "default" | "meeting";
  /**
   * Lip-sync engine selection (spec §14: MotionSync is the primary path, the analyzer the fallback).
   *  - "auto" (default): MotionSync when the Core is reachable and the model ships a .motionsync3.json, else analyzer
   *  - "motionsync": require MotionSync; `prepare()` throws MotionSyncUnavailableError (BLOCKED_BY_MOTIONSYNC_CORE) otherwise
   *  - "analyzer": never try MotionSync
   */
  lipSyncEngine?: "auto" | "motionsync" | "analyzer";
  /** URL of live2dcubismmotionsynccore.min.js (default: vendored path). */
  motionSyncCoreUrl?: string;
  /** Override the .motionsync3.json URL (default: model3.json FileReferences.MotionSync, resolved against the model dir). */
  motionSyncJsonUrl?: string;
  /** Called with diagnostics (core source, blocked features). */
  onDiagnostic?: (d: Live2DDiagnostic) => void;
}

export interface Live2DDiagnostic {
  core?: CoreResolution;
  lipSync: "analyzer" | "motionsync";
  blocked: string[];
  motionSyncJson?: string;
  motionSyncEngine?: { name: string; version: string };
  modelUrl?: string;
  parameterCount?: number;
  missingCanonicalParams?: string[];
}

// Minimal structural types for the pieces of pixi-live2d-display we touch (keeps the vendor
// SDK out of the public surface).
interface CoreModelLike {
  setParameterValueById(id: string, value: number, weight?: number): void;
  getModel(): { parameters: { ids: string[]; minimumValues: Float32Array; maximumValues: Float32Array } };
  getParameterValueByIndex(index: number): number;
  setParameterValueByIndex(index: number, value: number, weight?: number): void;
}
interface InternalModelLike {
  coreModel: CoreModelLike;
  motionManager: { stopAllMotions(): void; expressionManager?: { resetExpression(): void; setExpression(idx: number | string): Promise<boolean> } };
  eyeBlink?: unknown;
  breath?: unknown;
  lipSync: boolean;
  settings: { expressions?: { Name: string; File: string }[]; json?: { FileReferences?: { MotionSync?: string } } };
  originalWidth: number;
  originalHeight: number;
  on(event: "beforeMotionUpdate", cb: () => void): void;
  off(event: "beforeMotionUpdate", cb: () => void): void;
  updateFocus(): void;
}
interface Live2DModelLike {
  internalModel: InternalModelLike;
  anchor: { set(x: number, y: number): void };
  scale: { set(v: number): void };
  x: number;
  y: number;
  expression(id?: number | string): Promise<boolean>;
  destroy(opts?: { children?: boolean; texture?: boolean; baseTexture?: boolean }): void;
}

/**
 * Live2D (Cubism 4) AvatarProvider. Rendering via pixi.js + pixi-live2d-display; every parameter
 * is written from our MotionStack each frame (the library's own idle/blink/breath/focus/lipsync
 * are disabled so there is exactly one driver). Physics and pose keep running on top.
 */
export class Live2DAvatarProvider extends MotionStackAvatarBase {
  readonly id = "live2d";
  private app: { stage: { addChild(c: unknown): void }; view: HTMLCanvasElement; renderer: { resize(w: number, h: number): void; width: number; height: number }; destroy(removeView?: boolean, opts?: unknown): void; screen: { width: number; height: number } } | null = null;
  private model: Live2DModelLike | null = null;
  private ids: Record<ParamName, string> = resolveParamIds();
  private table: ParamTable = new Map();
  private pending: [string, number][] = [];
  private writeHandler: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private diag: Live2DDiagnostic = { lipSync: "analyzer", blocked: [] };
  private fileExpression: string | null = null;
  private motionSync: MotionSyncLipSync | null = null;
  private motionSyncIds: string[] = [];

  constructor(private readonly opts: Live2DAvatarOptions) {
    super(opts);
  }

  get diagnostics(): Live2DDiagnostic {
    return { ...this.diag, blocked: [...this.diag.blocked] };
  }

  protected async loadModel(character: CharacterDefinition): Promise<void> {
    const core = await resolveCoreUrl({ coreUrl: this.opts.coreUrl, vendorUrl: this.opts.vendorCoreUrl, cdnUrl: this.opts.cdnCoreUrl, allowCdn: this.opts.allowCdn });
    this.diag.core = core;
    await loadCubismCore(core.url);

    // pixi + pixi-live2d-display are imported lazily so the Core global exists first.
    const PIXI = await import("pixi.js");
    (globalThis as unknown as { PIXI: unknown }).PIXI = PIXI;
    const { Live2DModel, MotionPreloadStrategy } = await import("pixi-live2d-display/cubism4");
    Live2DModel.registerTicker(PIXI.Ticker as never);

    const container = this.opts.container;
    const meeting = this.opts.framing === "meeting";
    if (meeting && character.view?.background) {
      container.style.background = character.view.background;
      container.style.color = inkFor(character.view.background);
    }
    const app = new PIXI.Application({
      backgroundAlpha: 0,
      antialias: !meeting,
      autoDensity: true,
      resolution: Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1),
      width: Math.max(1, container.clientWidth || 480),
      height: Math.max(1, container.clientHeight || 640),
    });
    app.view.style.width = "100%";
    app.view.style.height = "100%";
    app.view.style.display = "block";
    container.appendChild(app.view as HTMLCanvasElement);
    this.app = app as unknown as typeof this.app;

    const modelUrl = `${character.baseUrl}/${character.model}`;
    this.diag.modelUrl = modelUrl;
    const model = (await Live2DModel.from(modelUrl, {
      autoInteract: false,
      autoUpdate: true,
      motionPreload: MotionPreloadStrategy.NONE,
      idleMotionGroup: "__rcai_no_idle__",
    })) as unknown as Live2DModelLike;
    this.model = model;
    const im = model.internalModel;
    im.motionManager.stopAllMotions();
    im.eyeBlink = undefined; // our BlinkController drives blinks
    im.breath = undefined; // our idle clips + BreathingController drive breathing
    im.lipSync = false; // audio-driven LipSyncEngine drives the mouth
    im.updateFocus = () => {}; // gaze comes from the MotionStack gaze layer

    this.ids = resolveParamIds(character.paramIds);
    this.table = buildParamTable(im.coreModel.getModel().parameters);
    await this.setupMotionSync(character, modelUrl, im);
    this.diag.parameterCount = this.table.size;
    this.diag.missingCanonicalParams = (Object.keys(this.ids) as ParamName[]).filter((k) => !this.table.has(this.ids[k])).map((k) => `${k}→${this.ids[k]}`);

    // Write our parameters before the motion/expression/physics pass of every pixi frame.
    this.writeHandler = () => {
      const core = im.coreModel;
      for (const [id, v] of this.pending) core.setParameterValueById(id, v);
    };
    im.on("beforeMotionUpdate", this.writeHandler);

    model.anchor.set(0.5, 0.5);
    app.stage.addChild(model as never);
    this.layout(character);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.layout(character));
      this.resizeObserver.observe(container);
    }
    this.opts.onDiagnostic?.(this.diagnostics);
  }

  /**
   * MotionSync slot (spec §14). The proprietary Core is never bundled: when it cannot be loaded the
   * provider records BLOCKED_BY_MOTIONSYNC_CORE and keeps the audio analyzer (also audio-driven).
   */
  private async setupMotionSync(character: CharacterDefinition, modelUrl: string, im: InternalModelLike): Promise<void> {
    const mode = this.opts.lipSyncEngine ?? "auto";
    if (mode === "analyzer" || (mode === "auto" && this.opts.lipSync && !(this.opts.lipSync instanceof AnalyzerLipSync))) return;
    const modelDir = modelUrl.slice(0, modelUrl.lastIndexOf("/") + 1);
    const jsonRef = this.opts.motionSyncJsonUrl ?? (character as { motionSync?: string }).motionSync ?? im.settings.json?.FileReferences?.MotionSync;
    const jsonUrl = jsonRef ? (jsonRef.startsWith("/") || /^https?:/.test(jsonRef) ? jsonRef : (character as { motionSync?: string }).motionSync ? `${character.baseUrl}/${jsonRef}` : `${modelDir}${jsonRef}`) : undefined;
    const coreUrl = this.opts.motionSyncCoreUrl ?? DEFAULT_VENDOR_MOTIONSYNC_CORE_URL;
    try {
      if (!jsonUrl) throw new MotionSyncUnavailableError(`model ${character.model} has no .motionsync3.json`);
      if (mode === "auto" && this.opts.motionSyncCoreUrl === undefined && !(await defaultHeadCheck(coreUrl))) {
        throw new MotionSyncUnavailableError(`core script not available at ${coreUrl}`);
      }
      const res = await fetch(jsonUrl);
      if (!res.ok) throw new MotionSyncUnavailableError(`${jsonUrl} → ${res.status}`);
      const json = await res.json();
      const core = im.coreModel;
      const ids = core.getModel().parameters.ids;
      const model: ParameterModel = {
        getParameterIndex: (id) => ids.indexOf(id),
        getParameterValueByIndex: (i) => core.getParameterValueByIndex(i),
        setParameterValueByIndex: (i, v) => core.setParameterValueByIndex(i, v),
      };
      const ms = await MotionSyncLipSync.create({ coreUrl, motionSync: json, model, mouthOpenId: this.ids.mouthOpenY, mouthFormId: this.ids.mouthForm });
      this.motionSync = ms;
      this.motionSyncIds = ms.data.settings.flatMap((s) => s.cubismParameters.map((p) => p.id));
      this.lipSync = ms;
      this.diag.lipSync = "motionsync";
      this.diag.motionSyncJson = jsonUrl;
      const eng = ms.sync && (await import("./motionsync/engine.js")).MotionSyncCriEngine.get();
      if (eng) this.diag.motionSyncEngine = { name: eng.name, version: `${eng.version.major}.${eng.version.minor}.${eng.version.patch}` };
    } catch (e) {
      if (!(e instanceof MotionSyncUnavailableError)) throw e;
      if (mode === "motionsync") throw e;
      this.diag.blocked.push("BLOCKED_BY_MOTIONSYNC_CORE");
      if (!(this.lipSync instanceof AnalyzerLipSync)) this.lipSync = new AnalyzerLipSync();
      this.diag.lipSync = "analyzer";
    }
  }

  private layout(character: CharacterDefinition): void {
    if (!this.app || !this.model) return;
    const container = this.opts.container;
    const w = Math.max(1, container.clientWidth || 480);
    const h = Math.max(1, container.clientHeight || 640);
    this.app.renderer.resize(w, h);
    const im = this.model.internalModel;
    const view = this.opts.framing === "meeting" ? { ...(character.view ?? {}), ...(character.view?.meeting ?? {}) } : (character.view ?? {});
    // Fit the model height into the container, then apply the pack's scale; portrait framing.
    const fit = Math.min(w / im.originalWidth, h / im.originalHeight);
    const scale = fit * (view.scale ?? 1) * 1.15;
    this.model.scale.set(scale);
    this.model.x = w / 2 + (view.x ?? 0) * w;
    this.model.y = h / 2 + (view.y ?? 0) * h + (im.originalHeight * scale - h) * 0.2;
  }

  protected applyParams(params: AvatarParams): void {
    if (!this.table.size) return;
    const pending = toLive2DValues(params, this.ids, this.table);
    if (this.motionSync) {
      if (this.stack.isSpeaking) {
        // The Core's own parameter values (ParamMouthOpenY/Form, ParamA/I/U/E/O …) win over the canonical mouth channel.
        for (const w of this.motionSync.getParameterWrites()) pending.push([w.id, w.value]);
      } else {
        for (const id of this.motionSyncIds) if (this.table.has(id)) pending.push([id, 0]);
      }
    }
    this.pending = pending;
  }

  protected override applyFileExpression(_emotion: Emotion, file: string, _intensity: number): void {
    const model = this.model;
    if (!model) return;
    const list = model.internalModel.settings.expressions ?? [];
    const match = list.find((e) => e.Name === file || e.File === file || e.File.endsWith(`/${file}`) || e.File === `expressions/${file}.exp3.json`);
    if (!match) return;
    if (this.fileExpression === match.Name) return;
    this.fileExpression = match.Name;
    void model.expression(match.Name);
  }

  override setEmotion(emotion: Emotion, intensity: number): void {
    super.setEmotion(emotion, intensity);
    const custom = this.character?.expressions?.[emotion];
    if (typeof custom !== "string" && this.fileExpression) {
      this.fileExpression = null;
      this.model?.internalModel.motionManager.expressionManager?.resetExpression();
    }
  }

  protected async disposeModel(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.model && this.writeHandler) this.model.internalModel.off("beforeMotionUpdate", this.writeHandler);
    this.writeHandler = null;
    this.model?.destroy({ children: true });
    this.model = null;
    this.app?.destroy(true, { children: true });
    this.app = null;
    this.motionSync?.dispose();
    this.motionSync = null;
    this.table = new Map();
    this.pending = [];
  }
}
