import { Worker } from "node:worker_threads";
import type { STTAdapter } from "./stt.js";

type Reply = { id: number; model?: string; text?: string; error?: string };

/** Keep native offline decoding off the socket and VAD event loop. */
export class SherpaWorkerSTT implements STTAdapter {
  readonly engine = "sherpa-onnx";
  ready = false;
  model = "";
  private worker?: Worker;
  private nextId = 0;
  private readonly requests = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();

  constructor(private readonly modelDir: string | null) {}

  async init(): Promise<void> {
    if (!this.modelDir) return;
    try {
      const worker = new Worker(
        `const { parentPort, workerData } = require("node:worker_threads");
        const adapter = (async () => {
          const { tsImport } = await import(workerData.loader);
          const { SherpaSTT } = await tsImport(workerData.module, workerData.loader);
          const stt = new SherpaSTT(workerData.modelDir);
          await stt.init();
          if (!stt.ready) throw new Error("sherpa STT not ready");
          return stt;
        })();
        parentPort.on("message", async ({ id, args }) => {
          try {
            const stt = await adapter;
            const result = args ? { text: await stt.transcribe(...args) } : { model: stt.model };
            parentPort.postMessage({ id, ...result });
          } catch (error) { parentPort.postMessage({ id, error: error.message }); }
        });`,
        { eval: true, workerData: {
          loader: import.meta.resolve("tsx/esm/api"),
          module: new URL("./stt.ts", import.meta.url).href,
          modelDir: this.modelDir,
        } },
      );
      this.worker = worker;
      worker.on("message", (reply: Reply) => {
        const request = this.requests.get(reply.id);
        if (!request) return;
        this.requests.delete(reply.id);
        if (!this.requests.size) worker.unref();
        if (reply.error) request.reject(new Error(reply.error));
        else request.resolve(reply);
      });
      worker.on("error", error => this.fail(error));
      worker.on("exit", code => this.fail(new Error(`sherpa worker exited (${code})`)));
      this.model = (await this.request()).model ?? "";
      this.ready = true;
    } catch (error) {
      this.close();
      console.warn("[agent] sherpa worker init failed:", (error as Error).message);
    }
  }

  async transcribe(samples: Float32Array, sampleRate: number, language: string, vocabulary?: readonly string[]): Promise<string> {
    if (!this.ready) throw new Error("sherpa STT not ready");
    return (await this.request([samples, sampleRate, language, vocabulary])).text ?? "";
  }

  close(): void {
    const worker = this.worker;
    this.fail(new Error("sherpa worker closed"));
    void worker?.terminate();
  }

  private fail(error: Error): void {
    this.ready = false;
    this.worker = undefined;
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
  }

  private request(args?: [Float32Array, number, string, (readonly string[])?]): Promise<Reply> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("sherpa worker unavailable"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      worker.ref();
      try { worker.postMessage({ id, args }); }
      catch (error) {
        this.requests.delete(id);
        if (!this.requests.size) worker.unref();
        reject(error);
      }
    });
  }
}
