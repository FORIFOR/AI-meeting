/** Cubism Core loading (proprietary runtime; see docs/source-manifest.md). */

export const OFFICIAL_CUBISM_CORE_CDN = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";
export const DEFAULT_VENDOR_CORE_URL = "/vendor/live2d/live2dcubismcore.min.js";
export const DEFAULT_VENDOR_MOTIONSYNC_CORE_URL = "/vendor/live2d/live2dcubismmotionsynccore.min.js";

export interface CoreResolution {
  url: string;
  source: "option" | "vendor" | "cdn";
}

export type HeadCheck = (url: string) => Promise<boolean>;

export async function defaultHeadCheck(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return false;
    // Vite dev servers answer 200 + text/html (SPA fallback) for missing files; require a JS-ish type.
    const type = res.headers.get("content-type") ?? "";
    return !/text\/html/i.test(type);
  } catch {
    return false;
  }
}

/** Precedence: explicit option → vendored local file (HEAD check) → official CDN. */
export async function resolveCoreUrl(opts: { coreUrl?: string; vendorUrl?: string; cdnUrl?: string; head?: HeadCheck; allowCdn?: boolean } = {}): Promise<CoreResolution> {
  if (opts.coreUrl) return { url: opts.coreUrl, source: "option" };
  const vendor = opts.vendorUrl ?? DEFAULT_VENDOR_CORE_URL;
  const head = opts.head ?? defaultHeadCheck;
  if (await head(vendor)) return { url: vendor, source: "vendor" };
  if (opts.allowCdn === false) {
    throw new Error(`BLOCKED_BY_LIVE2D_CORE_OFFLINE: strict_local forbids the Cubism Core CDN; place live2dcubismcore.min.js at ${vendor}`);
  }
  return { url: opts.cdnUrl ?? OFFICIAL_CUBISM_CORE_CDN, source: "cdn" };
}

const loading = new Map<string, Promise<void>>();

/** Injects the Core <script> once and resolves when `window.Live2DCubismCore` exists. */
export function loadScriptOnce(url: string, globalName: string): Promise<void> {
  const w = globalThis as unknown as Record<string, unknown>;
  if (w[globalName]) return Promise.resolve();
  const existing = loading.get(url);
  if (existing) return existing;
  const p = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("loadScriptOnce requires a DOM"));
      return;
    }
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => (w[globalName] ? resolve() : reject(new Error(`${url} loaded but ${globalName} is missing`)));
    s.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(s);
  });
  loading.set(url, p);
  p.catch(() => loading.delete(url));
  return p;
}

export function loadCubismCore(url: string): Promise<void> {
  return loadScriptOnce(url, "Live2DCubismCore");
}

export function isCubismCoreLoaded(): boolean {
  return Boolean((globalThis as unknown as Record<string, unknown>).Live2DCubismCore);
}
