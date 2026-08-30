/**
 * Dev-only audio resource registry (Gate 2 lifecycle evidence).
 * Wraps `AudioContext` and `getUserMedia` so every context / MediaStreamTrack the page creates is
 * tracked; `window.__rcaiAudio.live()` reports what is still open. Enabled when `import.meta.env.DEV`
 * or the page URL carries `?debug=1`. Never active in production builds without the flag.
 */
export interface LiveAudio {
  contexts: number;
  tracks: number;
  contextStates: string[];
  createdContexts: number;
  createdTracks: number;
}

const contexts = new Set<BaseAudioContext>();
const tracks = new Set<MediaStreamTrack>();
let createdContexts = 0;
let createdTracks = 0;
let installed = false;

function prune(): void {
  for (const c of contexts) if ((c.state as string) === "closed") contexts.delete(c);
  for (const t of tracks) if (t.readyState === "ended") tracks.delete(t);
}

export function live(): LiveAudio {
  prune();
  return { contexts: contexts.size, tracks: tracks.size, contextStates: [...contexts].map((c) => c.state), createdContexts, createdTracks };
}

export function trackContext(ctx: BaseAudioContext): void {
  createdContexts++;
  contexts.add(ctx);
}

export function trackStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    createdTracks++;
    tracks.add(t);
    t.addEventListener("ended", () => tracks.delete(t), { once: true });
  }
}

export function shouldEnable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (import.meta.env?.DEV) return true;
  } catch {
    /* not under Vite */
  }
  return new URLSearchParams(window.location.search).get("debug") === "1";
}

/** Installs the global wrappers once; safe to call repeatedly. */
export function installAudioDebugRegistry(): void {
  if (installed || !shouldEnable()) return;
  installed = true;
  const w = window as unknown as Record<string, unknown>;
  const OrigCtx = window.AudioContext;
  if (OrigCtx) {
    const Wrapped = function (this: AudioContext, ...args: ConstructorParameters<typeof AudioContext>) {
      const ctx = new OrigCtx(...args);
      trackContext(ctx);
      return ctx;
    } as unknown as typeof AudioContext;
    Wrapped.prototype = OrigCtx.prototype;
    Object.setPrototypeOf(Wrapped, OrigCtx);
    window.AudioContext = Wrapped;
  }
  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === "function") {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const stream = await orig(constraints);
      trackStream(stream);
      return stream;
    };
  }
  w.__rcaiAudio = { live, trackContext, trackStream };
}
