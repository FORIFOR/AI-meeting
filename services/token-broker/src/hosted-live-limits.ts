/** Bounds input before forwarding to a paid provider. Hosted sessions are audio/text only. */
export class HostedLiveLimits {
  private audioBytes = 0;
  private textBytes = 0;
  private messages = 0;
  constructor(private readonly seconds: number) {}
  check(message: Record<string, any>): void {
    if (++this.messages > 15_000) throw new Error('message limit');
    const keys = Object.keys(message);
    if (keys.length !== 1 || !['setup','realtimeInput','clientContent','toolResponse'].includes(keys[0]!)) throw new Error('unsupported input');
    const audio = message.realtimeInput?.audio;
    if (audio) {
      if (Object.keys(message.realtimeInput).length !== 1 || audio.mimeType !== 'audio/pcm;rate=16000' || typeof audio.data !== 'string' || audio.data.length > 64_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data)) throw new Error('invalid audio');
      this.audioBytes += Buffer.byteLength(audio.data, 'base64');
      if (this.audioBytes > this.seconds * 32_000) throw new Error('audio limit');
    } else {
      // Inline media or URLs hidden in a content/tool envelope must not bypass the audio-only cap.
      const text = JSON.stringify(message);
      if (/"(?:inlineData|inline_data|fileData|file_data|video|mediaChunks|media_chunks|audio)"\s*:/.test(text)) throw new Error('unsupported media');
      this.textBytes += Buffer.byteLength(text);
      if (this.textBytes > 100_000) throw new Error('text limit');
    }
    if (message.setup) {
      const setup = message.setup;
      delete setup.sessionResumption;
      delete setup.session_resumption;
      delete setup.cachedContent;
      delete setup.cached_content;
      delete setup.contextWindowCompression;
      delete setup.context_window_compression;
      delete setup.generation_config;
      setup.generationConfig = { ...setup.generationConfig, responseModalities: ['AUDIO'], candidateCount: 1, maxOutputTokens: 1024 };
      if (setup.tools) {
        if (!Array.isArray(setup.tools) || setup.tools.some((tool: any) => Object.keys(tool).some(key => key !== 'functionDeclarations') || !Array.isArray(tool.functionDeclarations) || tool.functionDeclarations.some((f: any) => !['session_tasks','read_user_context','lookup_live_info'].includes(f.name)))) throw new Error('unsupported tools');
      }
    }
  }
}
