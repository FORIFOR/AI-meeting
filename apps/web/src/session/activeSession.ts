/**
 * Single registry of the controller that currently owns audio resources, so route changes and
 * page unload (`pagehide`) can always release it — even when React's unmount cleanup did not run
 * (bfcache, navigation from a non-React link). See docs/audio-lifecycle.md.
 */
export interface Disposable {
  dispose(): Promise<void>;
}

let active: Disposable | null = null;
let listening = false;

export function setActiveSession(d: Disposable | null): void {
  if (active && active !== d) void active.dispose().catch(() => {});
  active = d;
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener("pagehide", () => void disposeActiveSession(), { capture: true });
  }
}

export function getActiveSession(): Disposable | null {
  return active;
}

export async function disposeActiveSession(): Promise<void> {
  const d = active;
  active = null;
  if (d) await d.dispose().catch(() => {});
}
