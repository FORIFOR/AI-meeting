import { GenerationCounter, type ConversationEvent, type GenerationRef } from "@rcai/conversation-core";

/** Raw server event from the `oai-events` data channel. */
export interface OpenAIServerEvent {
  type: string;
  event_id?: string;
  item_id?: string;
  response_id?: string;
  delta?: string;
  transcript?: string;
  text?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { type?: string; code?: string; message?: string };
  response?: { id?: string; status?: string; status_details?: { reason?: string } };
  [key: string]: unknown;
}

/**
 * Stateful mapper: OpenAI Realtime server events → Unified ConversationEvent (spec §4).
 * Accumulates user transcript deltas per item so partials arrive as full-text `final:false`
 * (the runtime replaces user partials, appends assistant partials).
 * Event names verified 2026-08-30 against developers.openai.com/api/docs/api-reference/realtime-server-events;
 * legacy (2024 beta) names are accepted too.
 */
export class OpenAIEventMapper {
  private userPartials = new Map<string, string>();
  private speaking = false;
  /** Generation epoch: one generation per `response.id`; cancelled responses are dropped. */
  private counter = new GenerationCounter();
  private responseGen = new Map<string, number>();
  private cancelled = new Set<string>();
  private activeResponse: string | null = null;
  private speakingResponse: string | null = null;
  /** Observability: raw events dropped because their response was cancelled. */
  staleDrops = 0;

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * Whether a response is in flight. `response.cancel` with nothing to cancel is answered with
   * "Cancellation failed: no active response found", which surfaces as a provider error and ends the
   * session — so a barge-in that lands between responses must not send it.
   */
  get hasActiveResponse(): boolean {
    // Only the server's response lifecycle counts. Audio keeps playing locally after `response.done`,
    // so "still speaking" is not the same as "still cancellable".
    return this.activeResponse !== null;
  }

  /** The current generation stamp (for providers that synthesise events, e.g. safety timers). */
  get generation(): GenerationRef {
    return this.counter.current();
  }

  reset(): void {
    this.userPartials.clear();
    this.speaking = false;
    this.responseGen.clear();
    this.cancelled.clear();
    this.activeResponse = null;
    this.speakingResponse = null;
  }

  /** Called by the provider when it sends `response.cancel`: everything else from that response is stale. */
  markCancelled(responseId: string | null = this.activeResponse): GenerationRef {
    if (responseId) this.cancelled.add(responseId);
    const gen = this.counter.current();
    if (responseId === this.activeResponse) this.activeResponse = null;
    if (responseId === this.speakingResponse) this.speakingResponse = null;
    return gen;
  }

  private stamp(responseId?: string): GenerationRef {
    const g = this.counter.stamp();
    const known = responseId ? this.responseGen.get(responseId) : undefined;
    return known !== undefined ? { ...g, generationId: known } : g;
  }

  map(raw: OpenAIServerEvent, at?: number): ConversationEvent[] {
    // Any assistant-side event for a cancelled response is a late chunk → dropped here.
    if (raw.response_id && this.cancelled.has(raw.response_id) && raw.type !== "response.done" && raw.type !== "output_audio_buffer.cleared") {
      this.staleDrops++;
      return [];
    }
    switch (raw.type) {
      case "session.created":
      case "session.updated":
        return [];
      case "input_audio_buffer.speech_started":
        this.counter.nextTurn();
        return [{ type: "user_speech_started", at }];
      case "input_audio_buffer.speech_stopped":
        return [{ type: "user_speech_ended", at }];
      case "conversation.item.input_audio_transcription.delta": {
        const key = raw.item_id ?? "_";
        const acc = (this.userPartials.get(key) ?? "") + (raw.delta ?? "");
        this.userPartials.set(key, acc);
        return acc ? [{ type: "user_transcript", text: acc, final: false }] : [];
      }
      case "conversation.item.input_audio_transcription.completed": {
        const key = raw.item_id ?? "_";
        this.userPartials.delete(key);
        const text = raw.transcript ?? "";
        return text.trim() ? [{ type: "user_transcript", text, final: true }] : [];
      }
      case "conversation.item.input_audio_transcription.failed":
        return [{ type: "error", error: new Error(`input transcription failed: ${raw.error?.message ?? "unknown"}`) }];
      case "response.created": {
        const id = raw.response?.id ?? raw.response_id ?? null;
        const gen = this.counter.nextGeneration();
        if (id) {
          this.responseGen.set(id, gen.generationId);
          this.activeResponse = id;
        }
        return [{ type: "assistant_thinking", gen: this.stamp(id ?? undefined) }];
      }
      case "output_audio_buffer.started":
        this.speaking = true;
        this.speakingResponse = raw.response_id ?? this.activeResponse;
        return [{ type: "assistant_speech_started", at, gen: this.stamp(raw.response_id) }];
      case "output_audio_buffer.stopped": {
        const was = this.speaking;
        this.speaking = false;
        const gen = this.stamp(raw.response_id ?? this.speakingResponse ?? undefined);
        this.speakingResponse = null; // the response is over; nothing left to cancel
        return was ? [{ type: "assistant_speech_ended", at, gen }] : [];
      }
      case "output_audio_buffer.cleared": {
        this.speaking = false;
        const gen = this.stamp(raw.response_id ?? this.speakingResponse ?? undefined);
        this.markCancelled(raw.response_id ?? this.speakingResponse ?? this.activeResponse);
        this.speakingResponse = null;
        return [{ type: "interrupted", at, gen }];
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": // legacy
        return raw.delta ? [{ type: "assistant_transcript", text: raw.delta, final: false, gen: this.stamp(raw.response_id) }] : [];
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": // legacy
        return [{ type: "assistant_transcript", text: raw.transcript ?? "", final: true, gen: this.stamp(raw.response_id) }];
      case "response.output_text.delta":
      case "response.text.delta": // legacy
        return raw.delta ? [{ type: "assistant_transcript", text: raw.delta, final: false, gen: this.stamp(raw.response_id) }] : [];
      case "response.output_text.done":
      case "response.text.done": // legacy
        return [{ type: "assistant_transcript", text: raw.text ?? "", final: true, gen: this.stamp(raw.response_id) }];
      case "response.function_call_arguments.done": {
        let args: Record<string, unknown> = {};
        try {
          args = raw.arguments ? (JSON.parse(raw.arguments) as Record<string, unknown>) : {};
        } catch {
          args = { _raw: raw.arguments };
        }
        return [{ type: "tool_call", call: { id: raw.call_id ?? raw.item_id ?? "", name: raw.name ?? "", arguments: args }, gen: this.stamp(raw.response_id) }];
      }
      case "response.done": {
        const id = raw.response?.id ?? raw.response_id ?? null;
        // Audio end is signalled by output_audio_buffer.stopped; a cancelled response while
        // no audio was started should still release the "thinking" state.
        if (raw.response?.status === "cancelled") {
          const alreadyCancelled = !!id && this.cancelled.has(id);
          const gen = this.stamp(id ?? undefined);
          this.markCancelled(id);
          if (alreadyCancelled) {
            this.staleDrops++;
            return [];
          }
          return this.speaking ? [] : [{ type: "interrupted", at, gen }];
        }
        if (id === this.activeResponse) this.activeResponse = null;
        if (id && id === this.speakingResponse) this.speakingResponse = null;
        if (raw.response?.status === "failed") return [{ type: "error", error: new Error(raw.response.status_details?.reason ?? "response failed") }];
        return [];
      }
      case "error": {
        const message = raw.error?.message ?? "openai realtime error";
        // A cancel that raced the end of a response changes nothing and must not reach the user as an
        // error — surfacing it ended sessions that were working perfectly.
        if (/no active response found/i.test(message)) return [];
        return [{ type: "error", error: new Error(message), fatal: raw.error?.type === "invalid_request_error" && raw.error?.code === "session_expired" }];
      }
      default:
        return [];
    }
  }
}
