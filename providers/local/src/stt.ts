import { OutboundAudioConverter, type PCMFrame } from "@rcai/audio-core";
import type { STTProvider, STTResult } from "@rcai/provider-core";
import { isLoopbackUrl } from "./loopback.js";

export interface LocalSTTOptions {
  agentUrl: string;
  fetchImpl?: typeof fetch;
}

/** Utterance-level local STT via the agent's `POST /stt` (raw PCM16 @ 16 kHz). */
export class LocalSTTProvider implements STTProvider {
  readonly id = "local" as const;
  private chunks: Int16Array[] = [];
  private converter = new OutboundAudioConverter({ targetRate: 16000, chunkMs: 20 });
  private language = "ja-JP";
  private listeners: ((r: STTResult) => void)[] = [];
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(opts: LocalSTTOptions) {
    this.base = opts.agentUrl.replace(/^ws/, "http").replace(/\/$/, "");
    this.f = opts.fetchImpl ?? fetch;
    if (!isLoopbackUrl(this.base)) throw new Error("LocalSTTProvider requires a loopback agent URL");
  }

  async start(opts: { language: string }): Promise<void> {
    this.language = opts.language;
    this.chunks = [];
  }

  pushAudio(frame: PCMFrame): void {
    this.chunks.push(...this.converter.push(frame));
  }

  onResult(cb: (r: STTResult) => void): void {
    this.listeners.push(cb);
  }

  async endUtterance(): Promise<STTResult | null> {
    const tail = this.converter.flush();
    if (tail) this.chunks.push(tail);
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    if (total === 0) return null;
    const merged = new Int16Array(total);
    let o = 0;
    for (const c of this.chunks) { merged.set(c, o); o += c.length; }
    this.chunks = [];
    const res = await this.f(`${this.base}/stt?language=${encodeURIComponent(this.language)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: merged.buffer as ArrayBuffer });
    if (!res.ok) throw new Error(`local stt ${res.status}`);
    const json = (await res.json()) as { text: string };
    const result: STTResult = { text: json.text, final: true, language: this.language };
    for (const l of this.listeners) l(result);
    return result;
  }

  async stop(): Promise<void> {
    this.chunks = [];
  }
}
