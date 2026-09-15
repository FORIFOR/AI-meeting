import { VertexUsage } from "./vertex-usage.js";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { WebSocket } from "ws";
import type { BrokerEnv } from "./env.js";
import { publicDemoOnly } from "./public-access.js";

/** OAuth credentials stay on the broker. Clients receive a two-minute, model-bound relay ticket. */
export class VertexLiveRelay {
  private readonly auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  private readonly secret: string;
  private readonly used = new Map<string, number>();
  constructor(private readonly env: BrokerEnv) { this.secret = env.MEETING_TOKEN_SECRET ?? randomBytes(32).toString("hex"); }
  get model(): string { return this.env.VERTEX_LIVE_MODEL ?? "gemini-live-2.5-flash-native-audio"; }
  async evaluationAuth() {
    const accessToken = await this.auth.getAccessToken();
    if (!accessToken) throw new Error("Vertex AI authentication failed");
    const location = this.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
    return { accessToken, baseUrl: `https://${location}-aiplatform.googleapis.com/v1/projects/${this.env.GOOGLE_CLOUD_PROJECT}/locations/${location}/publishers/google` };
  }
  mint() {
    if (!this.env.GOOGLE_CLOUD_PROJECT) throw new Error("GOOGLE_CLOUD_PROJECT is required for Vertex AI");
    const expiresAt = Date.now() + 120_000;
    const payload = Buffer.from(JSON.stringify({ expiresAt, model: this.model, nonce: randomBytes(24).toString("hex") })).toString("base64url");
    const token = `${payload}.${this.sign(payload)}`;
    return { token, expiresAt, model: this.model, backend: "vertex", websocketPath: "/api/live/vertex" };
  }
  private sign(payload: string) { return createHmac("sha256", this.secret).update(payload).digest("base64url"); }
  consume(token: string): string | null {
    if (publicDemoOnly(this.env)) return null;
    try {
      for (const [key, expires] of this.used) if (expires <= Date.now()) this.used.delete(key);
      const [payload, signature] = token.split(".");
      if (!payload || !signature) return null;
      const expected = Buffer.from(this.sign(payload));
      const actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (data.expiresAt <= Date.now() || data.model !== this.model || this.used.has(token) || this.used.size >= 10_000) return null;
      this.used.set(token, data.expiresAt);
      return data.model;
    } catch { return null; }
  }
  async connect(client: WebSocket, model: string) {
    const usage = new VertexUsage(model);
    const observationId = randomBytes(12).toString("hex");
    const startedAt = Date.now();
    let reportedEnd = false;
    const report = (phase: "checkpoint" | "closed") => console.log(JSON.stringify({ event: "vertex_live_usage", observationId, phase, model, elapsedMs: Date.now() - startedAt, ...usage.snapshot() }));
    const checkpoint = setInterval(() => report("checkpoint"), 60000);
    checkpoint.unref();
    client.once("close", () => {
      clearInterval(checkpoint);
      if (!reportedEnd) { reportedEnd = true; report("closed"); }
    });
    let upstream: WebSocket | undefined;
    const forward = (data: string) => { upstream!.send(data); usage.outbound(JSON.parse(data)); };
    const pending: string[] = [];
    let bytes = 0;
    let setup = false;
    const finish = () => { if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate(); else upstream?.close(); };
    client.on("error", finish);
    client.on("close", finish);
    client.on("message", (raw) => {
      try {
        const text = raw.toString();
        const msg = JSON.parse(text);
        if (!setup) {
          if (!msg.setup) throw new Error("setup required");
          msg.setup.model = `projects/${this.env.GOOGLE_CLOUD_PROJECT}/locations/${this.env.GOOGLE_CLOUD_LOCATION ?? "us-central1"}/publishers/google/models/${model}`;
          setup = true;
        } else if (msg.setup) throw new Error("duplicate setup");
        const data = JSON.stringify(msg);
        if (upstream?.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > 4_000_000) throw new Error("backpressure");
          forward(data);
        } else {
          bytes += Buffer.byteLength(data);
          if (bytes > 1_000_000) throw new Error("buffer limit");
          pending.push(data);
        }
      } catch { client.close(1008, "Invalid Vertex Live message"); }
    });
    const timer = setTimeout(() => { client.close(1011, "Vertex Live setup timed out"); finish(); }, 20_000);
    client.once("close", () => clearTimeout(timer));
    try {
      const token = await this.auth.getAccessToken();
      if (!token) throw new Error("missing ADC token");
      if (client.readyState !== WebSocket.OPEN) return;
      const location = this.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
      upstream = new WebSocket(`wss://${location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 15_000, maxPayload: 4_000_000 });
      upstream.on("open", () => { for (const data of pending.splice(0)) forward(data); });
      upstream.on("message", (data) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > 4_000_000) { client.close(1008, "Slow client"); return; }
        try { const message = JSON.parse(data.toString()); usage.inbound(message); if (message.setupComplete) clearTimeout(timer); } catch { /* provider handles decoding */ }
        client.send(data.toString());
      });
      upstream.on("close", (code, reason) => { clearTimeout(timer); client.close(code === 1006 || code === 1005 ? 1011 : code, reason.toString().slice(0, 100)); });
      upstream.on("error", () => { client.close(1011, "Vertex Live upstream connection failed"); });
    } catch { clearTimeout(timer); client.close(1011, "Vertex AI authentication failed"); }
  }
}
