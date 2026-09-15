import { AudioNormalizer, INTERNAL_SAMPLE_RATE, createPcmTapNode, type AudioSink, type PCMFrame, type PcmTapNode } from "@rcai/audio-core";
import type { AvatarProvider, SynchronizedAvatarAudio } from "./types.js";

export interface SynchronizedAvatarSinkOptions {
  sink: AudioSink;
  avatar: () => AvatarProvider | null;
}

interface Binding {
  avatar: AvatarProvider;
  audio: SynchronizedAvatarAudio;
  output: MediaStream;
  unsubscribe: () => void;
  element: HTMLAudioElement | null;
  submittedAudio: boolean;
}

interface Capture {
  binding: Binding;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode | null;
  mute: GainNode | null;
  tap: PcmTapNode | null;
  unsubscribe: (() => void) | null;
  element: HTMLAudioElement | null;
  normalizer: AudioNormalizer;
  deadline: ReturnType<typeof setTimeout> | null;
}

export const SYNCHRONIZED_CAPTURE_TIMEOUT_MS = 8_000;

/**
 * Sends source audio to an external renderer before any playback. Only its synchronized return
 * reaches the underlying sink/tap. After cancellation that external session is never reused:
 * an uncorrelated late video/audio packet cannot be safely assigned to a later assistant turn.
 */
export class SynchronizedAvatarSink implements AudioSink {
  readonly tap;
  private binding: Binding | null = null;
  private readonly rejected = new WeakSet<SynchronizedAvatarAudio>();
  private capture: Capture | null = null;
  private sourceStream: MediaStream | null = null;
  private audibleStream: MediaStream | null = null;
  private sourceGate = false;
  private sequenceOpen = false;
  private localStreamNeedsResume = false;
  private disposed = false;
  private killedBelow = 0;
  staleFramesDropped = 0;

  constructor(private readonly options: SynchronizedAvatarSinkOptions) {
    // Observation remains downstream. Never subscribe here and feed played audio back upstream.
    this.tap = options.sink.tap;
  }

  get isPlaying(): boolean { return !this.disposed && this.options.sink.isPlaying; }

  play(frame: PCMFrame, opts: { generationId?: number } = {}): void | boolean {
    if (this.disposed || !frame.data.length) return false;
    if (opts.generationId !== undefined && opts.generationId < this.killedBelow) {
      this.staleFramesDropped++;
      return false;
    }
    const binding = this.selectBinding();
    if (!binding) return this.options.sink.play(frame, opts);
    this.sendSource(binding, frame);
    // A failed send may already have submitted part of this frame. Never replay it locally.
    return true;
  }

  attachStream(stream: MediaStream): void {
    if (this.disposed) return;
    if (this.sourceStream !== stream) this.stopCapture();
    this.sourceStream = stream;
    const binding = this.selectBinding();
    if (binding) this.ensureCapture(binding, stream);
    else if (!this.localStreamNeedsResume) this.attachAudible(stream);
  }

  detachStream(): void {
    if (this.disposed) return;
    this.sourceGate = false;
    this.sequenceOpen = false;
    this.sourceStream = null;
    this.stopCapture();
    if (this.binding) this.fallback(this.binding, "ANAM_SOURCE_DETACHED");
    else this.detachAudible();
  }

  resumeStream(): void {
    if (this.disposed) return;
    this.sourceGate = true;
    this.localStreamNeedsResume = false;
    const binding = this.selectBinding();
    if (binding && this.sourceStream) this.ensureCapture(binding, this.sourceStream);
    else if (!binding && this.sourceStream) this.attachAudible(this.sourceStream);
    this.options.sink.resumeStream?.();
  }

  endTurn(): void {
    if (this.disposed) return;
    this.sourceGate = false;
    this.capture?.normalizer.reset();
    const binding = this.binding;
    if (!binding) { this.options.sink.endTurn?.(); return; }
    if (!this.sequenceOpen) return;
    this.sequenceOpen = false;
    try { binding.audio.endSourceTurn(); }
    catch { this.fallback(binding, "ANAM_AUDIO_END_FAILED"); }
    // Returned AV may still be playing. Normal source completion must not mute it.
  }

  /** Source EOF is not returned-media EOF. A later user turn must retire unconfirmed old AV. */
  beginUserTurn(): boolean {
    if (this.disposed || !this.binding?.submittedAudio) return false;
    this.sourceGate = false;
    this.sequenceOpen = false;
    this.localStreamNeedsResume = true;
    this.options.sink.interrupt();
    this.fallback(this.binding, "ANAM_UNCONFIRMED_OUTPUT_REQUIRES_LOCAL_FALLBACK", true, true);
    return true;
  }

  interrupt(minGeneration?: number): number {
    if (minGeneration !== undefined) this.killedBelow = Math.max(this.killedBelow, minGeneration);
    this.sourceGate = false;
    this.sequenceOpen = false;
    this.localStreamNeedsResume = true;
    const elapsed = this.options.sink.interrupt(minGeneration);
    if (this.binding) this.fallback(this.binding, "ANAM_INTERRUPTED_REQUIRES_LOCAL_FALLBACK", true, true);
    else this.stopCapture();
    return elapsed;
  }

  clearQueue(minGeneration?: number): number { return this.interrupt(minGeneration); }

  /** Releases only this adapter's resources. The caller still owns the speaker and media tracks. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.interrupt();
    this.stopCapture();
    this.detachAudible();
    this.sourceStream = null;
  }

  private selectBinding(): Binding | null {
    const avatar = this.options.avatar();
    const audio = avatar?.synchronizedAudio;
    if (this.binding) {
      if (this.binding.avatar === avatar && this.binding.audio === audio) return this.binding;
      this.fallback(this.binding, "ANAM_AUDIO_UNAVAILABLE");
      return null;
    }
    if (!avatar || !audio || this.rejected.has(audio)) return null;
    let output: MediaStream | null;
    try { output = audio.getOutputStream(); }
    catch { output = null; }
    if (!output || !this.options.sink.attachStream) {
      this.rejected.add(audio);
      this.retireAvatar(avatar, audio, "ANAM_AUDIO_UNAVAILABLE", false);
      return null;
    }
    const binding: Binding = { avatar, audio, output, unsubscribe: () => {}, element: null, submittedAudio: false };
    this.binding = binding;
    try {
      const unsubscribe = audio.onFailure(() => this.fallback(binding, "ANAM_AUDIO_UNAVAILABLE"));
      if (this.binding !== binding) { unsubscribe(); return null; }
      binding.unsubscribe = unsubscribe;
      this.options.sink.interrupt();
      this.attachAudible(output);
      binding.element = this.activateMedia(output, () => {
        if (this.binding === binding) this.fallback(binding, "ANAM_AUDIO_PLAYBACK_FAILED");
      });
      this.options.sink.resumeStream?.();
      return binding;
    } catch {
      this.fallback(binding, "ANAM_AUDIO_UNAVAILABLE");
      return null;
    }
  }

  private sendSource(binding: Binding, frame: PCMFrame): void {
    if (this.disposed || this.binding !== binding || !frame.data.length) return;
    this.sequenceOpen = true;
    binding.submittedAudio = true;
    try { binding.audio.pushSourceAudio(frame); }
    catch { this.fallback(binding, "ANAM_AUDIO_SEND_FAILED"); }
  }

  private attachAudible(stream: MediaStream): void {
    if (this.audibleStream === stream) return;
    this.options.sink.attachStream?.(stream);
    this.audibleStream = stream;
  }

  private detachAudible(): void {
    this.options.sink.detachStream?.();
    this.audibleStream = null;
  }

  private fallback(binding: Binding, reason: string, alreadyMuted = false, explicitInterrupt = false): void {
    if (this.binding !== binding) return;
    this.binding = null;
    this.rejected.add(binding.audio);
    this.sequenceOpen = false;
    try { binding.unsubscribe(); } catch { /* Continue synchronous audio cleanup. */ }
    if (!alreadyMuted) this.options.sink.interrupt(this.killedBelow);
    this.detachAudible();
    this.stopCapture();
    this.releaseMedia(binding.element);
    // Unsubscribe first: an explicit interrupt may synchronously notify failure again.
    this.retireAvatar(binding.avatar, binding.audio, reason, explicitInterrupt);
    this.localStreamNeedsResume = !this.sourceGate;
    if (!this.disposed && this.sourceGate && this.sourceStream) {
      this.attachAudible(this.sourceStream);
      this.options.sink.resumeStream?.();
    }
  }

  private retireAvatar(avatar: AvatarProvider, audio: SynchronizedAvatarAudio, reason: string, explicitInterrupt: boolean): void {
    // A DualRenderer failure listener may already have selected local before ours runs. Calling
    // interrupt() then would interrupt the healthy local mouth rather than the failed cloud session.
    if (explicitInterrupt && avatar.synchronizedAudio === audio) {
      try { avatar.interrupt(); } catch { /* Cloud teardown below remains authoritative. */ }
    }
    if (avatar.useLocalFallback) {
      try { avatar.useLocalFallback(reason); } catch { /* Source playback remains available. */ }
    } else {
      // A direct external provider has no local-switch owner to release its SDK/media connection.
      try { void avatar.stop().catch(() => {}); } catch { /* Local audio is already detached. */ }
    }
  }

  private ensureCapture(binding: Binding, stream: MediaStream): void {
    if (this.capture?.stream === stream && this.capture.binding === binding) return;
    this.stopCapture();
    let context: AudioContext;
    try { context = new AudioContext({ sampleRate: INTERNAL_SAMPLE_RATE, latencyHint: "interactive" }); }
    catch { this.fallback(binding, "ANAM_SOURCE_CAPTURE_UNAVAILABLE"); return; }
    const capture: Capture = {
      binding, stream, context, source: null, mute: null, tap: null,
      unsubscribe: null, element: null, normalizer: new AudioNormalizer(), deadline: null,
    };
    this.capture = capture;
    capture.deadline = setTimeout(() => {
      if (this.capture === capture && !this.disposed) this.fallback(binding, "ANAM_SOURCE_CAPTURE_TIMEOUT");
    }, SYNCHRONIZED_CAPTURE_TIMEOUT_MS);
    void this.startCapture(capture).catch(() => {
      if (this.capture === capture && !this.disposed) this.fallback(binding, "ANAM_SOURCE_CAPTURE_UNAVAILABLE");
    });
  }

  private async startCapture(capture: Capture): Promise<void> {
    const { context, stream, binding } = capture;
    capture.source = context.createMediaStreamSource(stream);
    capture.mute = context.createGain();
    capture.mute.gain.value = 0;
    capture.mute.connect(context.destination);
    capture.element = this.activateMedia(stream, () => {
      if (this.capture === capture) this.fallback(binding, "ANAM_SOURCE_CAPTURE_UNAVAILABLE");
    });
    const tap = await createPcmTapNode(context, 10);
    if (this.capture !== capture || this.disposed) { tap.dispose(); return; }
    capture.tap = tap;
    capture.unsubscribe = tap.onChunk((chunk) => {
      if (this.disposed || this.capture !== capture || this.binding !== binding || !this.sourceGate) return;
      this.sendSource(binding, capture.normalizer.push({ data: chunk, sampleRate: context.sampleRate, channels: 1 }));
    });
    capture.source.connect(tap.node);
    tap.node.connect(capture.mute);
    if (context.state !== "running") await context.resume();
    if (capture.deadline !== null) clearTimeout(capture.deadline);
    capture.deadline = null;
  }

  private stopCapture(): void {
    const capture = this.capture;
    if (!capture) return;
    this.capture = null; // Invalidates callbacks and any in-flight worklet/context setup immediately.
    if (capture.deadline !== null) clearTimeout(capture.deadline);
    capture.deadline = null;
    try { capture.unsubscribe?.(); } catch { /* Already removed. */ }
    try { capture.tap?.dispose(); } catch { /* Continue releasing the context. */ }
    try { capture.source?.disconnect(); } catch { /* Already disconnected. */ }
    try { capture.mute?.disconnect(); } catch { /* Already disconnected. */ }
    this.releaseMedia(capture.element);
    if ((capture.context.state as string) !== "closed") void capture.context.close().catch(() => {});
    // Source tracks belong to the conversational provider; never stop them on renderer fallback.
  }

  private activateMedia(stream: MediaStream, failed: () => void): HTMLAudioElement | null {
    if (typeof document === "undefined") return null;
    const element = document.createElement("audio");
    element.muted = true;
    element.autoplay = true;
    element.style.display = "none";
    element.srcObject = stream;
    document.body?.appendChild(element);
    // Chrome needs a playing media element before remote WebRTC audio flows into WebAudio.
    void element.play().catch(failed);
    return element;
  }

  private releaseMedia(element: HTMLAudioElement | null): void {
    if (!element) return;
    try { element.pause(); } catch { /* Detached or already stopped. */ }
    element.srcObject = null;
    element.remove();
  }
}
