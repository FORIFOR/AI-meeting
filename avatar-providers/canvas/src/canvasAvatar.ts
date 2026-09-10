import { MotionStackAvatarBase, neutralParams, type AvatarParams, type CharacterDefinition, type MotionStackAvatarOptions } from "@rcai/avatar-core";

export interface CanvasAvatarOptions extends MotionStackAvatarOptions {
  container: HTMLElement;
  /** Accent colour for hair/clothes. */
  accent?: string;
  /** Optional caption for environments where the video tile has no surrounding UI. */
  label?: string;
  /** Character id used to locate a bundled preview image in a GPU-limited bot browser. */
  characterId?: string;
  /** Prefer the bundled character artwork over the generic diagnostic face. */
  staticPreview?: boolean;
}

/**
 * Lightweight 2D renderer. Draws a stylised face from the same canonical AvatarParams the
 * Live2D/VRM providers consume. It is used as a visible fallback when a meeting page cannot
 * initialise WebGL, and also remains useful for local renderer diagnostics.
 */
export class CanvasAvatarProvider extends MotionStackAvatarBase {
  readonly id = "canvas";
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private accent: string;
  private name = "";
  private label = "";
  private background = "#f3f0ea";
  private readonly characterId?: string;
  private readonly staticPreview: boolean;
  private previewImage: HTMLImageElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly opts: CanvasAvatarOptions) {
    super(opts);
    this.accent = opts.accent ?? "#6b5b95";
    this.characterId = opts.characterId;
    this.staticPreview = opts.staticPreview === true;
  }

  protected async loadModel(character: CharacterDefinition): Promise<void> {
    this.name = character.manifest.name;
    this.label = this.opts.label ?? this.name;
    this.background = character.view?.background ?? this.background;
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    this.opts.container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.resize();
    if (this.staticPreview) {
      const image = new Image();
      image.onload = () => {
        this.previewImage = image;
        this.resize();
        this.applyParams(neutralParams());
      };
      image.src = `/avatar-fallbacks/${encodeURIComponent(this.characterId ?? character.manifest.id)}.png`;
    }
    // Paint immediately after the canvas is attached. Attendee's webpage streamer may capture
    // its first frame before requestAnimationFrame runs, so waiting for the motion loop can yield
    // an apparently blank bot camera even though the provider is ready.
    this.applyParams(neutralParams());
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.opts.container);
    }
  }

  private resize(): void {
    if (!this.canvas) return;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const w = Math.max(1, this.opts.container.clientWidth || 480);
    const h = Math.max(1, this.opts.container.clientHeight || 640);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  protected applyParams(p: AvatarParams): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    if (this.staticPreview) {
      drawPreview(ctx, canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height, this.previewImage, this.name, this.label);
      return;
    }
    drawFace(ctx, canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height, p, { accent: this.accent, background: this.background, name: this.name, label: this.label, state: this.state });
  }

  protected async disposeModel(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
  }
}

/** Draws a bundled preview without ever flashing the generic diagnostic face in a meeting tile. */
function drawPreview(ctx: CanvasRenderingContext2D, w: number, h: number, image: HTMLImageElement | null, name: string, label: string): void {
  if (!image) return;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#f3f0ea";
  ctx.fillRect(0, 0, w, h);
  const scale = Math.min(w / image.naturalWidth, h / image.naturalHeight);
  const dw = image.naturalWidth * scale;
  const dh = image.naturalHeight * scale;
  ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.fillStyle = "rgba(0,0,0,0.58)";
  ctx.font = "16px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`${label || name} · AIミーティング`, 16, h - 16);
  ctx.restore();
}

export interface DrawStyle {
  accent: string;
  background: string;
  name: string;
  label?: string;
  state: string;
}

/** Pure drawing routine (exported for tests / other debug surfaces). */
export function drawFace(ctx: CanvasRenderingContext2D, w: number, h: number, p: AvatarParams, style: DrawStyle): void {
  ctx.save();
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, w, h);
  const cx = w / 2 + p.bodyAngleX * 3;
  const cy = h * 0.42;
  const R = Math.min(w, h) * 0.2;

  // Body (torso) with sway + breathing.
  ctx.save();
  ctx.translate(cx, cy + R * 1.2);
  ctx.rotate((p.bodyAngleZ * Math.PI) / 180);
  ctx.fillStyle = style.accent;
  const breath = 1 + p.breath * 0.02;
  ctx.beginPath();
  ctx.ellipse(0, R * 1.4, R * 1.35 * breath, R * 1.6, 0, Math.PI, 2 * Math.PI);
  ctx.fill();
  // arms
  ctx.strokeStyle = style.accent;
  ctx.lineWidth = R * 0.32;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-R * 1.2, R * 1.2);
  ctx.lineTo(-R * 1.6 - p.armL * R * 0.4, R * 2.2 - p.armL * R * 1.4);
  ctx.moveTo(R * 1.2, R * 1.2);
  ctx.lineTo(R * 1.6 + p.armR * R * 0.4, R * 2.2 - p.armR * R * 1.4);
  ctx.stroke();
  ctx.restore();

  // Head with rotation (angleZ = roll, angleX/Y as parallax shifts).
  ctx.save();
  ctx.translate(cx + p.angleX * 1.2, cy - p.angleY * 1.0);
  ctx.rotate((-p.angleZ * Math.PI) / 180);
  // hair back
  ctx.fillStyle = style.accent;
  ctx.beginPath();
  ctx.ellipse(0, -R * 0.1, R * 1.12, R * 1.18, 0, 0, 2 * Math.PI);
  ctx.fill();
  // face
  ctx.fillStyle = "#ffe4cf";
  ctx.beginPath();
  ctx.ellipse(0, 0, R, R * 1.08, 0, 0, 2 * Math.PI);
  ctx.fill();
  // fringe
  ctx.fillStyle = style.accent;
  ctx.beginPath();
  ctx.ellipse(0, -R * 0.75, R * 1.02, R * 0.45, 0, Math.PI, 2 * Math.PI);
  ctx.fill();
  // cheeks
  if (p.cheek > 0.02) {
    ctx.fillStyle = `rgba(255,120,140,${0.35 * p.cheek})`;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * R * 0.55, R * 0.25, R * 0.18, R * 0.1, 0, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  const px = p.angleX * 0.35 + p.eyeBallX * R * 0.1;
  const py = -p.angleY * 0.25 - p.eyeBallY * R * 0.08;
  // eyes
  for (const s of [-1, 1]) {
    const open = s < 0 ? p.eyeLOpen : p.eyeROpen;
    const smile = s < 0 ? p.eyeLSmile : p.eyeRSmile;
    const ex = s * R * 0.4 + px * 0.3;
    const ey = -R * 0.1 + py * 0.3;
    const eh = R * 0.16 * Math.max(0, Math.min(1.3, open)) * (1 - smile * 0.6);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.ellipse(ex, ey, R * 0.16, Math.max(0.5, eh), 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(ex, ey, R * 0.16, Math.max(0.5, eh), 0, 0, 2 * Math.PI);
    ctx.clip();
    ctx.fillStyle = "#3b2f4a";
    ctx.beginPath();
    ctx.ellipse(ex + p.eyeBallX * R * 0.07, ey + -p.eyeBallY * R * 0.05, R * 0.085, R * 0.11, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
    if (smile > 0.3) {
      ctx.strokeStyle = "#3b2f4a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ex, ey + R * 0.05, R * 0.15, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    }
    // brow
    const by = s < 0 ? p.browLY : p.browRY;
    const bf = s < 0 ? p.browLForm : p.browRForm;
    ctx.strokeStyle = "#4a3a2a";
    ctx.lineWidth = R * 0.05;
    ctx.beginPath();
    ctx.moveTo(ex - R * 0.16, ey - R * 0.28 - by * R * 0.1 + bf * s * R * 0.04);
    ctx.quadraticCurveTo(ex, ey - R * 0.36 - by * R * 0.1 - bf * R * 0.05, ex + R * 0.16, ey - R * 0.28 - by * R * 0.1 - bf * s * R * 0.04);
    ctx.stroke();
  }
  // mouth: open (height) + form (width/curve)
  const mw = R * (0.28 + p.mouthForm * 0.1);
  const mh = R * 0.02 + p.mouthOpenY * R * 0.28;
  const my = R * 0.5 + py * 0.2;
  ctx.fillStyle = "#b3444f";
  ctx.beginPath();
  if (p.mouthOpenY < 0.05) {
    ctx.strokeStyle = "#b3444f";
    ctx.lineWidth = R * 0.04;
    ctx.moveTo(px * 0.2 - mw, my);
    ctx.quadraticCurveTo(px * 0.2, my + p.mouthForm * R * 0.15, px * 0.2 + mw, my);
    ctx.stroke();
  } else {
    ctx.ellipse(px * 0.2, my, mw, mh, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillRect(px * 0.2 - mw * 0.6, my - mh, mw * 1.2, mh * 0.35);
  }
  ctx.restore();

  // caption
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`${style.label ?? style.name} · AIミーティング`, 10, h - 10);
  ctx.restore();
}
