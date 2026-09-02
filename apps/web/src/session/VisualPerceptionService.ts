import { VisualPerception, type FaceObservation, type VisualCue } from "@rcai/visual-core";

/**
 * The face model, kept behind one file.
 *
 * Attendee sends each participant's webcam at 360p / 2 fps as base64 JPEG. This decodes a frame, runs
 * MediaPipe's Face Landmarker over it, and hands the measurements to `@rcai/visual-core`, which owns
 * everything that is not the model: smoothing, gestures, absence.
 *
 * The model and its WASM runtime are self-hosted (`scripts/fetch-mediapipe.sh` → `/mediapipe/…`).
 * The page runs inside a meeting vendor's browser, and a page that only works while a third-party CDN
 * is reachable is a page that fails mid-call.
 *
 * It needs WebGL — the CPU delegate does too, measured — so it lives or dies with the same context
 * Live2D needs. Where that context exists it is cheap: 117 ms to load and a 13 ms median frame under
 * software rendering, against a 500 ms budget at Attendee's 2 fps. Where it does not, `start()` leaves
 * `blockedReason` set and the meeting carries on hearing instead of seeing.
 */
export interface VisualPerceptionOptions {
  /** Where the self-hosted model and wasm live. Default `/mediapipe`. */
  baseUrl?: string;
  /** Frames closer together than this are dropped (the model is slower than the stream is bursty). */
  minIntervalMs?: number;
  onCue?(cue: VisualCue): void;
}

export class VisualPerceptionService {
  private landmarker: unknown = null;
  private perception = new VisualPerception();
  private lastFrameAt = new Map<string, number>();
  private busy = false;
  private _ready = false;
  private _blocked: string | null = null;

  constructor(private readonly opts: VisualPerceptionOptions = {}) {}

  get ready(): boolean {
    return this._ready;
  }

  /** Why there are no cues, when there are none. Never a silent no-op. */
  get blockedReason(): string | null {
    return this._blocked;
  }

  async start(): Promise<void> {
    const base = this.opts.baseUrl ?? "/mediapipe";
    try {
      const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}/face_landmarker.task` },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
      this._ready = true;
      this._blocked = null;
    } catch (err) {
      // Missing model file, no WebGL/WASM, a vendor browser that blocks it — all end here, named.
      this._blocked = `BLOCKED_BY_MEDIAPIPE: ${err instanceof Error ? err.message : String(err)}`;
      this._ready = false;
    }
  }

  /**
   * One webcam frame. Returns the cue when the frame was actually measured, null when it was skipped —
   * the model runs slower than frames arrive, and queueing them would make every cue late.
   */
  async onFrame(participantId: string, jpegBase64: string, at = Date.now()): Promise<VisualCue | null> {
    if (!this._ready || this.busy) return null;
    const min = this.opts.minIntervalMs ?? 300;
    if (at - (this.lastFrameAt.get(participantId) ?? -Infinity) < min) return null;
    this.lastFrameAt.set(participantId, at);
    this.busy = true;
    try {
      const bitmap = await decodeJpeg(jpegBase64);
      if (!bitmap) return null;
      const lm = this.landmarker as { detectForVideo(image: unknown, ts: number): MpResult };
      const res = lm.detectForVideo(bitmap, at);
      bitmap.close?.();
      const shapes = res.faceBlendshapes?.[0]?.categories;
      if (!shapes?.length) return this.perception.absent(participantId, at);
      const blendshapes: Record<string, number> = {};
      for (const c of shapes) if (c.categoryName) blendshapes[c.categoryName] = c.score;
      const matrix = res.facialTransformationMatrixes?.[0]?.data;
      const observation: FaceObservation = { participantId, at, blendshapes, matrix: matrix ? Array.from(matrix) : undefined };
      const cue = this.perception.observe(observation);
      this.opts.onCue?.(cue);
      return cue;
    } catch {
      return null;
    } finally {
      this.busy = false;
    }
  }

  cue(participantId: string, now = Date.now()): VisualCue {
    return this.perception.cue(participantId, now);
  }

  stop(): void {
    (this.landmarker as { close?(): void } | null)?.close?.();
    this.landmarker = null;
    this._ready = false;
  }
}

interface MpResult {
  faceBlendshapes?: { categories: { categoryName?: string; score: number }[] }[];
  facialTransformationMatrixes?: { data: number[] | Float32Array }[];
}

/** base64 JPEG → an image the model can read, without ever touching the DOM's document. */
async function decodeJpeg(b64: string): Promise<(ImageBitmap & { close?(): void }) | null> {
  if (typeof createImageBitmap !== "function" || typeof fetch !== "function") return null;
  const res = await fetch(`data:image/jpeg;base64,${b64}`);
  const blob = await res.blob();
  return (await createImageBitmap(blob)) as ImageBitmap & { close?(): void };
}
