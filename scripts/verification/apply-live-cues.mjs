import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Temporary branch-only integration helper. Each existing source must still equal the reviewed blob.
const originals = {
  'apps/web/src/screens/Session.tsx': '25a1b97d1c52f5c7ed79ed19ee7d6f605cd01bd2',
  'apps/web/src/session/useSession.ts': '31e49cfbea473e5c21eec8fff30a56ce97a69fe5',
  'apps/web/src/session/SessionController.ts': '2f7be15caea2ca8c4f8ee598fd7b5d2eb7f8287f',
  'services/token-broker/src/app.ts': 'fecb594b6c0ddf5ccad616c37e9c4baad8838d5b',
  'services/token-broker/src/env.ts': '66afce644cd7d90f4b8f6ebc7e57856b4dea5535',
  'apps/web/src/session/SessionController.lifecycle.test.ts': '4b4aaf8c9b5870907b83887b7fe7304d2a8ea6eb',
};
for (const [path, hash] of Object.entries(originals)) {
  if (execFileSync('git', ['hash-object', path], {encoding:'utf8'}).trim() !== hash) throw new Error(`Reviewed source changed: ${path}`);
}
function patch(path, from, to) {
  const text = readFileSync(path,'utf8');
  if (text.split(from).length !== 2) throw new Error(`Expected one exact anchor in ${path}: ${from.slice(0,80)}`);
  writeFileSync(path,text.replace(from,to));
}
function append(path, text, guard) {
  const current=readFileSync(path,'utf8'); if(current.includes(guard)) throw new Error(`Already integrated: ${path}`);
  writeFileSync(path,current+text);
}

append('packages/conversation-core/src/index.ts','export * from "./liveCues.js";\n','./liveCues.js');
patch('packages/conversation-core/src/liveCues.ts',"    model: 'jev-1.13.0',","    model: 'jev-latest',");
patch('packages/conversation-core/src/liveCues.test.ts',"expect(body.model).toBe('jev-1.13.0')","expect(body.model).toBe('jev-latest')");
patch('packages/conversation-core/src/liveCues.ts',
  "  x.candidates.forEach((c, i) => { criteria[`c${i}`] = `${c.kind}: ${c.label}`; });",
  "  x.candidates.forEach((c, i) => { criteria[`c${i}`] = `${c.kind}: ${c.label}`; });\n  if (!x.candidates.length) criteria.context_only = 'No saved reference exists. Intent classification only; do not invent a reference.';");
patch('packages/conversation-core/src/liveCues.ts',
  "['none', ...x.candidates.map((_, i) => `c${i}`)]",
  "['none', ...(x.candidates.length ? x.candidates.map((_, i) => `c${i}`) : ['context_only'])]");
patch('packages/conversation-core/src/liveCues.ts',"focus.reliable && focus.choice !== 'none'","focus.reliable && /^c[0-9]+$/.test(focus.choice)");

patch('services/token-broker/src/env.ts','export interface BrokerEnv {',`export interface BrokerEnv {
  /** Optional decision-only TypeSafe integration; disabled on the public hosted profile. */
  RCAI_LIVE_CUES_ENABLED?: string;
  TYPESAFE_API_KEY?: string;
  TYPESAFE_DEFAULT_MODEL?: string;
  RCAI_LIVE_CUES_TOKEN?: string;
  RCAI_LIVE_CUES_ORIGIN?: string;`);
patch('services/token-broker/src/routes/liveCues.ts','body: JSON.stringify(jevCueRequest(input)),',"body: JSON.stringify({ ...jevCueRequest(input), model: env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest' }),");
patch('services/token-broker/src/app.ts','import { createOpenAILiveSession }',`import { createLiveCueRoutes } from "./routes/liveCues.js";
import { createOpenAILiveSession }`);
patch('services/token-broker/src/app.ts','origin === botPageOrigin ||',"origin === botPageOrigin || (c.req.path.startsWith('/api/live-cues') && origin === env.RCAI_LIVE_CUES_ORIGIN) ||");
patch('services/token-broker/src/app.ts','  app.get("/health", (c) =>',`  app.route('/api/live-cues', createLiveCueRoutes(env, fetchImpl, now));

  app.get("/health", (c) =>`);
append('services/token-broker/.env.example',`
# Optional single-operator Jev hints. Public hosted/demo profiles always deny this endpoint.
# These limits are per process, not a monetary billing cap. See docs/live-cues.md.
RCAI_LIVE_CUES_ENABLED=0
TYPESAFE_API_KEY=
TYPESAFE_DEFAULT_MODEL=jev-latest
# Generate a SEPARATE decision-only capability (32+ chars); never reuse an admin or API key.
RCAI_LIVE_CUES_TOKEN=
RCAI_LIVE_CUES_ORIGIN=http://localhost:5173
`,'RCAI_LIVE_CUES_ENABLED');

patch('apps/web/src/components/LiveCuePanel.tsx','  captions: Caption[]; tasks:', '  transcript?: string; captions: Caption[]; tasks:');
patch('apps/web/src/components/LiveCuePanel.tsx',"  const text = latest?.text.trim().slice(-800) ?? '';", "  const text = (p.transcript ?? latest?.text ?? '').trim().slice(-800);");
patch('apps/web/src/components/LiveCuePanel.tsx',"  const [consent, setConsent] = useState(false);", "  const [consent, setConsent] = useState(false);\n  const [consentBroker, setConsentBroker] = useState<string | null>(null);");
patch('apps/web/src/components/LiveCuePanel.tsx','cloudAllowed && consent && /^[^\\s]{32,512}$/.test(token)','cloudAllowed && consent && consentBroker === p.brokerUrl && /^[^\\s]{32,512}$/.test(token)');
patch('apps/web/src/components/LiveCuePanel.tsx','onChange={e => setConsent(e.target.checked)}','onChange={e => { setConsentBroker(p.brokerUrl); setConsent(e.target.checked); }}');

patch('apps/web/src/screens/Session.tsx','import "../styles/session-presence.css";',`import "../styles/session-presence.css";
import { LiveCuePanel } from "../components/LiveCuePanel.js";`);
patch('apps/web/src/screens/Session.tsx','        <SelfCamera enabled={!p.team && p.settings.cameraOn} />',`        <LiveCuePanel captions={s.captions} transcript={s.liveCueText} tasks={s.tasks}
          projectId={p.params.projectId} active={s.status === "live" && !s.muted}
          brokerUrl={p.settings.brokerUrl} privacyMode={p.settings.privacyMode} team={!!p.team} onCue={s.setLiveCue} />
        <SelfCamera enabled={!p.team && p.settings.cameraOn} />`);
patch('apps/web/src/session/useSession.ts','  const [captions, setCaptions] = useState<Caption[]>([]);',`  const [captions, setCaptions] = useState<Caption[]>([]);
  const [liveCueText, setLiveCueText] = useState("");`);
patch('apps/web/src/session/useSession.ts','  const onEvent = useCallback((e: ConversationEvent) => {',`  const onEvent = useCallback((e: ConversationEvent) => {
    // Invalidate advisory work at the start of a new turn, not only when revised text arrives.
    if (e.type === "user_speech_started" || e.type === "interrupted" || e.type === "session_closed") setLiveCueText("");
    if (e.type === "user_transcript") setLiveCueText(previous => (e.delta ? previous + e.text : e.text).slice(-800));`);
patch('apps/web/src/session/useSession.ts','    setLookup(null);','    setLookup(null);\n    setLiveCueText("");');
patch('apps/web/src/session/useSession.ts','  const interrupt = useCallback(() => void controller.current?.interrupt(), []);',`  const interrupt = useCallback(() => void controller.current?.interrupt(), []);
  const setLiveCue = useCallback((intent: import("@rcai/conversation-core").CueIntent) => { controller.current?.setLiveCue(intent); }, []);`);
patch('apps/web/src/session/useSession.ts','  return { avatarAvailability,','  return { liveCueText, setLiveCue, avatarAvailability,');
patch('apps/web/src/session/SessionController.ts','  private disposed = false;','  private disposed = false;\n  private lastLiveCueAt = -Infinity;');
patch('apps/web/src/session/SessionController.ts','  async interrupt(): Promise<void> {',`  /** Display-only intent cue. Never speaks, takes a turn, saves a task or approves an action. */
  setLiveCue(intent: import("@rcai/conversation-core").CueIntent): boolean {
    if (this.disposed || !this.avatarRuntime || !this.runtime ||
        !["idle", "listening", "interrupted"].includes(this.runtime.state) ||
        !["none", "explore", "compare", "clarify", "plan", "acknowledge"].includes(intent)) return false;
    const now = Date.now();
    if (intent !== "none" && now - this.lastLiveCueAt < 800) return false;
    if (intent !== "none") this.lastLiveCueAt = now;
    this.avatarRuntime.setEmotion(intent === "explore" || intent === "acknowledge" ? "warm_positive" : "neutral",
      intent === "acknowledge" ? 0.3 : intent === "explore" ? 0.18 : 0.12);
    return true;
  }

  async interrupt(): Promise<void> {`);
patch('apps/web/src/session/SessionController.lifecycle.test.ts','const avatarSetState = vi.fn();','const avatarSetState = vi.fn();\nconst avatarSetEmotion = vi.fn();');
patch('apps/web/src/session/SessionController.lifecycle.test.ts','    setEmotion() {},','    setEmotion: avatarSetEmotion,');
patch('apps/web/src/session/SessionController.lifecycle.test.ts','describe("SessionController lifecycle", () => {',`describe("SessionController lifecycle", () => {
  it("applies live cues only as quiet, optional expressions, not as speech or task authority", async () => {
    const c = makeController(); await c.start(); await c.whenAvatarSettled();
    for (const notify of providerListeners) notify({type:"user_speech_started"});
    avatarSetEmotion.mockClear(); toolResponse.mockClear();
    expect(c.setLiveCue("explore")).toBe(true);
    expect(avatarSetEmotion).toHaveBeenCalledWith("warm_positive", 0.18);
    expect(toolResponse).not.toHaveBeenCalled();
    avatarSetEmotion.mockClear();
    for (const notify of providerListeners) notify({type:"assistant_speech_started"});
    avatarSetEmotion.mockClear();
    expect(c.setLiveCue("compare")).toBe(false); expect(avatarSetEmotion).not.toHaveBeenCalled();
    await c.dispose(); expect(c.setLiveCue("none")).toBe(false);
  });`);
console.log('Applied reviewed live-cue integration; full verification is still required.');
