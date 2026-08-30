import { VRMAvatarProvider } from "../src/index.js";
import type { AvatarState, Emotion, Gesture } from "@rcai/avatar-core";

// Sample model: pixiv/ChatVRM `public/AvatarSample_B.vrm` (VRoid sample avatar; reference only, not redistributed).
const provider = new VRMAvatarProvider({ container: document.getElementById("stage")!, modelUrl: "/@fs/" + (import.meta.env.VITE_REPO_ROOT ?? "") + "/reference/ChatVRM/public/AvatarSample_B.vrm", background: "#1c1c24" });
const log = (s: string) => (document.getElementById("log")!.textContent = s + "\n" + document.getElementById("log")!.textContent);

await provider.prepare({
  manifest: { id: "demo", name: "Demo", renderer: "vrm", defaultPersona: "free_talk", supportedLanguages: ["ja-JP"], motionProfile: "expressive_v1", voiceProfiles: [] },
  baseUrl: "/", model: "AvatarSample_B.vrm", expressions: {}, motions: {}, voice: { characterId: "demo", voices: {} },
});
await provider.start();

const ui = document.getElementById("ui")!;
const btn = (label: string, fn: () => void) => { const b = document.createElement("button"); b.textContent = label; b.onclick = fn; ui.appendChild(b); };
for (const s of ["IDLE", "LISTENING", "THINKING", "SPEAKING", "INTERRUPTED"] as AvatarState[]) btn(s, () => { provider.setState(s); log("state " + s); });
for (const e of ["neutral", "smile", "laugh", "serious", "sad", "thinking", "surprised"] as Emotion[]) btn("😊 " + e, () => provider.setEmotion(e, 0.8));
for (const g of ["nod_normal", "head_tilt", "greeting", "bow", "celebrate", "point"] as Gesture[]) btn("▶ " + g, () => provider.performGesture(g, 0.8));
btn("blink", () => provider.blink(160));
btn("fake mouth", () => { provider.setState("SPEAKING"); provider.stack.setLipSync({ mouthOpenY: 0.7, mouthForm: 0.5 }); });
setInterval(() => { const p = provider.getParams(); log(`mouth ${p.mouthOpenY.toFixed(2)} eye ${p.eyeLOpen.toFixed(2)} head ${p.angleX.toFixed(1)},${p.angleY.toFixed(1)}`); }, 1000);
