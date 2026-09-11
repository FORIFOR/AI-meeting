import type { ConversationTask, TaskProposal } from "@rcai/conversation-core";
import type { LiveLookupResult } from "@rcai/meeting-core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationEvent, ProviderId } from "@rcai/conversation-core";
import type { AvatarState } from "@rcai/avatar-core";
import type { LatencyTracker } from "@rcai/audio-core";
import { SessionController, SessionDisposedError, type SessionInit, type SessionOutcome } from "./SessionController.js";
import type { DeferredFeedback } from "./sidecar.js";
import type { SessionReport } from "@rcai/observability";
import type { IncidentOptIn } from "./IncidentRecorder.js";

export interface Caption {
  id: number;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  /** Assistant generation that produced the caption (Round 3 Gate 1). */
  gen?: number;
  /** True when the turn was cut by the user. */
  interrupted?: boolean;
}

export type SessionStatus = "starting" | "live" | "ending" | "ended" | "error";

export interface ToastMsg {
  id: number;
  code?: string;
  message: string;
  kind: "error" | "info";
}

let seq = Date.now() % 1_000_000_000; // survives Vite HMR module re-evaluation (duplicate React keys otherwise)

export function useSession(init: Omit<SessionInit, "stage" | "handlers"> | null, stageRef: React.RefObject<HTMLDivElement | null>, onEnded: (o: SessionOutcome) => void) {
  const controller = useRef<SessionController | null>(null);
  const [status, setStatus] = useState<SessionStatus>("starting");
  const [avatarState, setAvatarState] = useState<AvatarState>("IDLE");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [providerId, setProviderId] = useState<ProviderId | null>(null);
  const [latency, setLatency] = useState<ReturnType<LatencyTracker["report"]> | null>(null);
  const [observability, setObservability] = useState<SessionReport | null>(null);
  const [incidentCount, setIncidentCount] = useState(0);
  const [incidentOptIn, setIncidentOptInState] = useState<IncidentOptIn>({ audio: false, video: false });
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [tasks, setTasks] = useState<ConversationTask[]>([]);
  const [taskProposals, setTaskProposals] = useState<TaskProposal[]>([]);
  const [muted, setMuted] = useState(false);
  const [lookup, setLookup] = useState<LiveLookupResult | null>(null);
  const deferred = useRef<DeferredFeedback[]>([]);
  /** Generation epoch mirror: captions from a cancelled generation are ignored even if a late event slips through. */
  const genRef = useRef({ accepted: 0, current: 0 });

  const toast = useCallback((message: string, code?: string, kind: ToastMsg["kind"] = "error") => {
    const id = seq++;
    setToasts((t) => [...t.slice(-3), { id, message, code, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const onEvent = useCallback((e: ConversationEvent) => {
    const g = genRef.current;
    const eventGen = "gen" in e && e.gen ? e.gen.generationId : undefined;
    if (e.type === "interrupted") {
      const cancelled = eventGen ?? g.current;
      g.accepted = Math.max(g.accepted, cancelled + 1);
    } else if (eventGen !== undefined && (e.type === "assistant_transcript" || e.type === "assistant_speech_started" || e.type === "assistant_speech_ended")) {
      if (eventGen < g.accepted) return; // stale caption from a cancelled generation
      g.current = eventGen;
    }
    setCaptions((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      switch (e.type) {
        case "user_transcript": {
          if (last && last.role === "user" && !last.final) next[next.length - 1] = { ...last, text: e.delta ? last.text + e.text : e.text, final: e.final !== false };
          else next.push({ id: seq++, role: "user", text: e.text, final: e.final !== false });
          break;
        }
        case "assistant_speech_started":
          if (!(last && last.role === "assistant" && !last.final)) next.push({ id: seq++, role: "assistant", text: "", final: false, gen: eventGen });
          break;
        case "assistant_transcript": {
          if (last && last.role === "assistant" && !last.final) {
            next[next.length - 1] = { ...last, text: e.final === false ? last.text + e.text : e.text, final: e.final === true, gen: eventGen ?? last.gen };
          } else next.push({ id: seq++, role: "assistant", text: e.text, final: e.final === true, gen: eventGen });
          break;
        }
        case "assistant_speech_ended":
          if (last && last.role === "assistant") next[next.length - 1] = { ...last, final: true };
          break;
        case "interrupted":
          if (last && last.role === "assistant") next[next.length - 1] = { ...last, final: true, interrupted: true };
          break;
        default:
          return prev;
      }
      return next.filter((c) => c.text.trim() || !c.final).slice(-4);
    });
  }, []);

  useEffect(() => {
    if (!init || !stageRef.current) return;
    setLookup(null);
    setTasks([]);
    setTaskProposals([]);
    let cancelled = false;
    const c = new SessionController({
      ...init,
      stage: stageRef.current,
      handlers: {
        onEvent,
        onAvatarState: (t) => setAvatarState(t.to),
        onError: (message, code) => toast(message, code),
        onProviderChange: (id) => setProviderId(id),
        onDeferred: (f) => deferred.current.push(f),
        onLookup: setLookup,
        onTasks: setTasks,
        onTaskProposals: setTaskProposals,
      },
    });
    controller.current = c;
    setStatus("starting");
    c.start()
      .then(() => {
        if (cancelled) return;
        setStatus("live");
      })
      .catch((err: unknown) => {
        if (cancelled || err instanceof SessionDisposedError) return;
        const message = err instanceof Error ? err.message : String(err);
        const code = /BLOCKED_BY_[A-Z_]+/.exec(message)?.[0];
        toast(message, code);
        setStatus("error");
      });
    const timer = setInterval(() => {
      setLatency(c.latencyReport());
      setObservability(c.observabilityReport());
    }, 500);
    return () => {
      // Runs on unmount, route change and React StrictMode's dev double-mount: the controller
      // aborts its own start() at the next checkpoint and releases everything it created.
      cancelled = true;
      clearInterval(timer);
      void c.dispose();
      controller.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init]);

  const end = useCallback(async () => {
    const c = controller.current;
    if (!c) return;
    setStatus("ending");
    try {
      const outcome = await c.end();
      controller.current = null;
      setStatus("ended");
      onEnded(outcome);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "END");
      setStatus("error");
    }
  }, [onEnded, toast]);

  const interrupt = useCallback(() => void controller.current?.interrupt(), []);
  const captureIncident = useCallback((note?: string) => {
    const c = controller.current;
    if (!c) return;
    const inc = c.captureIncident("不自然だった瞬間", note);
    if (inc) {
      setIncidentCount(c.incidents.length);
      toast(`記録しました（±5秒）: ${inc.id}`, undefined, "info");
    }
  }, [toast]);
  const setIncidentOptIn = useCallback((next: Partial<IncidentOptIn>) => {
    const c = controller.current;
    if (!c) return;
    c.setIncidentOptIn(next);
    setIncidentOptInState(c.incidentOptIn);
  }, []);
  const toggleMute = useCallback(() => {
    const c = controller.current;
    if (!c) return;
    const next = !c.isMuted;
    c.setMuted(next);
    setMuted(next);
  }, []);
  const switchProvider = useCallback(
    async (id: ProviderId) => {
      const c = controller.current;
      if (!c) return;
      try {
        toast(`切替中 → ${id}`, undefined, "info");
        await c.switchProvider(id);
        toast(`AI Engine: ${id}`, undefined, "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast(message, /BLOCKED_BY_[A-Z_]+/.exec(message)?.[0]);
      }
    },
    [toast],
  );

  const resolveTaskProposal = useCallback((id:string,accept:boolean)=>{
    controller.current?.resolveTaskProposal(id,accept);
  },[]);
  return { tasks, taskProposals, resolveTaskProposal, lookup, status, avatarState, captions, providerId, latency, observability, toasts, muted, end, interrupt, toggleMute, switchProvider, toast, captureIncident, setIncidentOptIn, incidentOptIn, incidentCount };
}
