import 'fake-indexeddb/auto';
import { TaskWorkspace } from '../state/taskWorkspace.js';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the heavy edges: audio devices and the vendor registry. Everything else is the real code.
const stopTrack = vi.fn();
const closeCtx = vi.fn(async () => {});
const providerDisconnect = vi.fn(async () => {});
const avatarStop = vi.fn(async () => {});
const micSetup = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); });
const avatarFactory = vi.fn(async () => {});
const avatarPrepare = vi.fn(async () => {});
const avatarStart = vi.fn(async () => {});
const avatarSetState = vi.fn();
const errors = vi.fn();
const taskProposals = vi.fn();
const toolResponse = vi.fn();
const providerConnect = vi.fn(async (_config?: any) => { await new Promise((r) => setTimeout(r, 5)); });
const providerListeners = new Set<(event: any) => void>();
const evaluate = vi.fn(async () => ({ overall: 0, clarity: 0, specificity: 0, structure: 0, relevance: 0, fluency: 0, feedback: [], improvedAnswer: "" }));

vi.mock("@rcai/audio-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rcai/audio-core")>();
  class SpeakerOutput {
    context = { state: "running", close: closeCtx, sampleRate: 48000 };
    tap = new orig.AudioTap();
    isPlaying = false;
    closed = false;
    async resume() {}
    async whenReady() {}
    play() { return true; }
    interrupt() { return 0; }
    async close() { this.closed = true; await closeCtx(); }
  }
  class MicCapture {
    stream: { getTracks: () => { stop: typeof stopTrack }[] } | null = null;
    stopped = false;
    async start() {
      await micSetup();
      if (this.stopped) {
        stopTrack();
        throw new Error("MicCapture stopped");
      }
      this.stream = { getTracks: () => [{ stop: stopTrack }] };
      return this.stream;
    }
    onFrame() { return () => {}; }
    async stop() { this.stopped = true; this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; }
    setMuted() {}
    get isMuted() { return false; }
    get mediaStream() { return this.stream; }
  }
  return { ...orig, SpeakerOutput, MicCapture };
});

vi.mock("../integrations/registry.js", () => ({
  plannerUrl: () => "http://127.0.0.1:1/plan",
  createHeuristicEvaluator: () => ({ id: "local", evaluate: async () => ({ overall: 0, clarity: 0, specificity: 0, structure: 0, relevance: 0, fluency: 0, feedback: [], improvedAnswer: "" }) }),
  createEvaluator: () => ({ id: "local", evaluate }),
  createAvatarProvider: async () => { await avatarFactory(); return ({
    id: "canvas",
    prepare: avatarPrepare,
    start: avatarStart,
    pushAudio() {},
    setState: avatarSetState,
    setEmotion() {},
    performGesture() {},
    setGaze() {},
    interrupt() {},
    stop: avatarStop,
  }); },
  createConversationProvider: async () => ({
    id: "local",
    capabilities: () => ({toolCalling:true}),
    sendToolResponse: toolResponse,
    connect: providerConnect,
    pushAudio() {},
    async sendText() {},
    async interrupt() {},
    async updateContext() {},
    disconnect: providerDisconnect,
    onEvent(listener: (event: any) => void) { providerListeners.add(listener); return () => providerListeners.delete(listener); },
  }),
}));

vi.mock("@rcai/avatar-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rcai/avatar-core")>();
  return { ...orig, loadCharacter: async () => ({ manifest: { id: "c", name: "C", renderer: "canvas", defaultPersona: "x", supportedLanguages: ["ja-JP"], motionProfile: "m", voiceProfiles: [] }, baseUrl: "/c", model: "m", expressions: {}, motions: {}, voice: { characterId: "c", voices: {} } }) };
});

import { SessionController, SessionDisposedError } from "./SessionController.js";
import { getActiveSession } from "./activeSession.js";

function makeController(privacyMode: "strict_local" | "default" = "strict_local", workspace?:TaskWorkspace) {
  return new SessionController({
    taskWorkspace: workspace,
    settings: { brokerUrl: "http://localhost:8787", agentUrl: "ws://localhost:8788", engine: "local", autoPolicy: "offline", advanced: {}, privacyMode, showHud: false, characterId: "c", cameraOn: false, captionsOn: true, voices: {}, expressive: false },
    availability: { openai: false, google: false, local: true },
    persona: { id: "p", name: "P", mode: workspace ? "task_planning" : "free_talk", systemPrompt: "x", language: "ja-JP", speakingStyle: { speed: "normal", energy: 0.5, politeness: "casual", sentenceLength: "short" }, turnPolicy: { maxSentences: 2, allowSilenceMs: 2000, backchannel: true, interruptible: true, correctionPolicy: "none" }, motionProfile: "m" },
    character: { id: "c", name: "C", renderer: "canvas", baseUrl: "/c" },
    params: {},
    stage: {} as HTMLElement,
    handlers: { onEvent() {}, onAvatarState() {}, onError: errors, onTaskProposals:taskProposals, onProviderChange() {} },
  });
}

describe("SessionController lifecycle", () => {
  afterEach(async () => { await getActiveSession()?.dispose(); vi.unstubAllGlobals(); });
  beforeEach(() => {
    vi.clearAllMocks(); providerListeners.clear();
    micSetup.mockImplementation(async () => {});
    avatarFactory.mockImplementation(async () => {});
    avatarPrepare.mockImplementation(async () => {});
    avatarStart.mockImplementation(async () => {});
    providerConnect.mockImplementation(async () => {});
  });
  it("never saves a model-proposed mutation before explicit review, even with a matching quote", async () => {
    const workspace=new TaskWorkspace(`voice-review-${crypto.randomUUID()}`), c=makeController('strict_local',workspace);
    await c.start();await c.whenAvatarSettled();
    const emit=(event:unknown)=>{for(const listener of providerListeners)listener(event);};
    emit({type:'user_transcript',text:'資料はまだ送っていない',final:true});
    emit({type:'tool_call',call:{id:'add',name:'session_tasks',arguments:{operations:[{action:'add',title:'資料',quote:'資料はまだ送っていない',status:'done'}]}}});
    await vi.waitFor(()=>expect(taskProposals).toHaveBeenCalled());
    expect(await workspace.read()).toEqual([]);
    expect(toolResponse.mock.calls.flat(3).some((x:any)=>x?.response?.status==='needs_user_confirmation')).toBe(true);
    const proposal=taskProposals.mock.calls.at(-1)![0][0];await c.resolveTaskProposal(proposal.id,false);
    expect(await workspace.read()).toEqual([]);
    emit({type:'tool_call',call:{id:'add2',name:'session_tasks',arguments:{operations:[{action:'add',title:'資料',quote:'資料',status:'pending'}]}}});
    await vi.waitFor(()=>expect(taskProposals.mock.calls.at(-1)![0]).toHaveLength(1));
    const reviewed=taskProposals.mock.calls.at(-1)![0][0];await c.resolveTaskProposal(reviewed.id,true);
    expect((await workspace.read())[0]).toMatchObject({title:'資料',status:'pending'});
    emit({type:'tool_call',call:{id:'wrong',name:'session_tasks',arguments:{operations:[{action:'update',id:(await workspace.read())[0]!.id,status:'done',quote:'資料を送ったら連絡します'}]}}});
    await vi.waitFor(()=>expect(taskProposals.mock.calls.at(-1)![0]).toHaveLength(1));
    const outcome=await c.end();expect(outcome.unconfirmedTaskChanges).toBe(1);
    expect((await workspace.read())[0]!.status).toBe('pending');
  });
  it("releases a late microphone grant without ever starting the avatar", async () => {
    const permission = deferred(); micSetup.mockReturnValue(permission.promise);
    const c=makeController(); const starting=c.start();
    const rejected=expect(starting).rejects.toBeInstanceOf(SessionDisposedError);
    await vi.waitFor(()=>expect(micSetup).toHaveBeenCalledOnce());
    await c.dispose(); permission.resolve(); await rejected;
    expect(avatarFactory).not.toHaveBeenCalled(); expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeCtx).toHaveBeenCalledOnce(); expect(getActiveSession()).toBeNull();
    await c.dispose(); expect(closeCtx).toHaveBeenCalledOnce();
  });
  it("full start → end closes owned resources exactly once", async () => {
    const c=makeController(); await c.start(); await c.whenAvatarSettled();
    expect(getActiveSession()).toBe(c); const out=await c.end();
    expect(out.providerId).toBe("local");expect(stopTrack).toHaveBeenCalledOnce();
    expect(providerDisconnect).toHaveBeenCalledOnce();expect(avatarStop).toHaveBeenCalledOnce();
    expect(closeCtx).toHaveBeenCalledOnce();expect(getActiveSession()).toBeNull();
    await c.dispose();expect(closeCtx).toHaveBeenCalledOnce();
  });
  it("keeps capture on recovery notices but releases it on fatal provider failure", async () => {
    const c=makeController();await c.start();await c.whenAvatarSettled();
    for(const notify of providerListeners)notify({type:"error",error:new Error("reconnecting"),fatal:false});
    expect(c.isDisposed).toBe(false);expect(stopTrack).not.toHaveBeenCalled();
    for(const notify of providerListeners)notify({type:"error",error:new Error("failed"),fatal:true});
    await vi.waitFor(()=>expect(closeCtx).toHaveBeenCalledOnce());expect(c.isDisposed).toBe(true);
  });
  it("does not connect before microphone permission, but never waits for renderer preparation", async () => {
    const permission=deferred(),assets=deferred();micSetup.mockReturnValue(permission.promise);avatarPrepare.mockReturnValue(assets.promise);
    const c=makeController();const starting=c.start();
    await vi.waitFor(()=>expect(micSetup).toHaveBeenCalledOnce());expect(providerConnect).not.toHaveBeenCalled();
    expect(avatarFactory).not.toHaveBeenCalled();permission.resolve();await starting;
    await vi.waitFor(()=>expect(avatarPrepare).toHaveBeenCalledOnce());expect(providerConnect).toHaveBeenCalledOnce();
    expect(c.isDisposed).toBe(false);assets.resolve();await c.whenAvatarSettled();await c.dispose();
  });
  it("hydrates speaking state on late attachment without replaying a prior turn", async () => {
    const assets=deferred();avatarPrepare.mockReturnValue(assets.promise);
    const c=makeController();await c.start();
    for(const notify of providerListeners)notify({type:"assistant_speech_started"});
    expect(c.avatarState).toBe("IDLE");assets.resolve();await c.whenAvatarSettled();
    expect(c.avatarState).toBe("SPEAKING");expect(avatarSetState).toHaveBeenCalledWith("SPEAKING");
    await c.interrupt();expect(c.avatarState).toBe("LISTENING");await c.dispose();
  });
  it("hydrates listening after an interruption, not the old speaking state", async () => {
    const assets=deferred();avatarPrepare.mockReturnValue(assets.promise);
    const c=makeController();await c.start();
    for(const notify of providerListeners)notify({type:"assistant_speech_started"});await c.interrupt();
    for(const notify of providerListeners)notify({type:"user_speech_started"});
    assets.resolve();await c.whenAvatarSettled();expect(c.avatarState).toBe("LISTENING");
    expect(avatarSetState).not.toHaveBeenCalledWith("SPEAKING");await c.dispose();
  });
  it("keeps voice connected when avatar preparation fails", async () => {
    avatarPrepare.mockRejectedValue(new Error("broken VRM"));
    const c=makeController();await c.start();await c.whenAvatarSettled();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("音声のみ"),"AVATAR_FALLBACK");
    expect(c.isDisposed).toBe(false);expect(providerDisconnect).not.toHaveBeenCalled();
    expect(avatarStop).toHaveBeenCalledOnce();await c.dispose();
  });
  it("ends voice immediately while renderer preparation is unresolved, then disposes late resources", async () => {
    const assets=deferred();avatarPrepare.mockReturnValue(assets.promise);
    const c=makeController();await c.start();await vi.waitFor(()=>expect(avatarPrepare).toHaveBeenCalledOnce());
    await c.dispose();expect(closeCtx).toHaveBeenCalledOnce();expect(stopTrack).toHaveBeenCalledOnce();
    expect(avatarStop).toHaveBeenCalled();assets.resolve();await c.whenAvatarSettled();
    expect(avatarStart).not.toHaveBeenCalled();expect(avatarSetState).not.toHaveBeenCalled();expect(errors).not.toHaveBeenCalled();
  });
  it("cleans a factory that returns after disposal and never prepares it", async () => {
    const factory=deferred();avatarFactory.mockReturnValue(factory.promise);
    const c=makeController();await c.start();await c.dispose();factory.resolve();await c.whenAvatarSettled();
    await vi.waitFor(()=>expect(avatarStop).toHaveBeenCalledOnce());expect(avatarPrepare).not.toHaveBeenCalled();expect(errors).not.toHaveBeenCalled();
  });
  it("cleans an avatar whose start completes after the voice session ended", async () => {
    const started=deferred();avatarStart.mockReturnValue(started.promise);
    const c=makeController();await c.start();await vi.waitFor(()=>expect(avatarStart).toHaveBeenCalledOnce());
    await c.end();expect(closeCtx).toHaveBeenCalledOnce();started.resolve();await c.whenAvatarSettled();
    expect(avatarStop).toHaveBeenCalled();expect(avatarSetState).not.toHaveBeenCalled();
  });
  it("does not start an avatar after microphone denial", async () => {
    const denied=new Error("Microphone permission denied");micSetup.mockRejectedValue(denied);
    const c=makeController();await expect(c.start()).rejects.toBe(denied);
    expect(providerConnect).not.toHaveBeenCalled();expect(avatarFactory).not.toHaveBeenCalled();expect(closeCtx).toHaveBeenCalledOnce();
  });
  it("does not start an avatar after provider connection fails", async () => {
    providerConnect.mockRejectedValue(new Error("connection failed"));const c=makeController();
    await expect(c.start()).rejects.toThrow("connection failed");expect(avatarFactory).not.toHaveBeenCalled();expect(closeCtx).toHaveBeenCalledOnce();
  });
  it("starts result evaluation while telemetry delivery remains pending", async () => {
    const delivery=deferred();const fetchImpl=vi.fn(async()=>{await delivery.promise;return new Response("{}");});vi.stubGlobal("fetch",fetchImpl);
    const c=makeController("default");await c.start();await c.whenAvatarSettled();const ending=c.end();
    try { await vi.waitFor(()=>expect(evaluate).toHaveBeenCalledOnce());expect(fetchImpl).toHaveBeenCalledOnce();expect(closeCtx).toHaveBeenCalledOnce(); }
    finally { delivery.resolve(); }
    expect((await ending).telemetry).toBe("sent");
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
