const key = (base: string) => `rcai.zoom.session:${base.replace(/\/$/, "")}`;
export const zoomToken = (base: string): string | null => {
  try { return sessionStorage.getItem(key(base)); } catch { return null; }
};
const pendingKey = "rcai.zoom.pending";
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function connectZoom(base: string, meetingUrl: string): Promise<void> {
  const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  sessionStorage.setItem(pendingKey, JSON.stringify({ base, verifier, meetingUrl }));
  location.assign(`${base.replace(/\/$/, "")}/api/zoom/connect?challenge=${challenge}`);
}
let completing: Promise<void> | null = null;
/** Same-tab navigation preserves the verifier without cookies on cross-origin fetches. */
export function completeZoom(): Promise<void> {
  if (completing) return completing;
  completing = (async () => {
    const state = new URLSearchParams(location.hash.slice(1)).get("zoom_oauth");
    const pending = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null") as { base: string; verifier: string; meetingUrl: string } | null;
    history.replaceState(null, "", location.pathname + location.search);
    if (!state || !pending) throw new Error("連携を開始したタブで、もう一度「Zoomと連携」を押してください。");
    sessionStorage.removeItem(pendingKey);
    const response = await fetch(`${pending.base.replace(/\/$/, "")}/api/zoom/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state, verifier: pending.verifier }) });
    if (!response.ok) throw new Error("Zoomの連携を完了できませんでした。もう一度連携してください。");
    const data = await response.json() as { token: string };
    sessionStorage.setItem(key(pending.base), data.token);
    sessionStorage.setItem("rcai.zoom.meeting", pending.meetingUrl);
  })();
  return completing;
}
export async function disconnectZoom(base: string): Promise<void> {
  const response = await fetch(`${base.replace(/\/$/, "")}/api/zoom/disconnect`, { method: "POST", headers: { Authorization: `Bearer ${zoomToken(base) ?? ""}` } });
  // Retain the application session on failure so a failed provider revocation can be retried.
  if (!response.ok) throw new Error("接続解除を完了できませんでした。もう一度お試しください。");
  sessionStorage.removeItem(key(base));
}
