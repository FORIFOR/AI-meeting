/// <reference types="@webgpu/types" />
import { orbShaderSource } from "./vendor/shader-source.js";
import { orbUniformFloatCount, writeOrbUniforms } from "./vendor/orb-uniforms.js";
import type { OrbParams } from "./vendor/presets.js";

export interface OrbRenderer { draw(params: OrbParams, delta: number, reducedMotion: boolean): void; dispose(): void }

/** One pass, at most 30 fps/512 px (scheduled by the component); no editor/runtime dependency. */
export async function createVoiceOrbRenderer(canvas: HTMLCanvasElement, signal: AbortSignal, onFailure: () => void): Promise<OrbRenderer | null> {
  if (!navigator.gpu || signal.aborted) return null;
  let device: GPUDevice | undefined;
  let context: GPUCanvasContext | null = null;
  let uniform: GPUBuffer | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    context?.unconfigure();
    uniform?.destroy();
    device?.destroy();
  };
  const fail = () => { if (!disposed) { dispose(); onFailure(); } };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
    if (!adapter || disposed) { dispose(); return null; }
    const acquired = await adapter.requestDevice();
    if (disposed) { acquired.destroy(); return null; }
    device = acquired;
    device.lost.then(fail);
    device.addEventListener("uncapturederror", (event) => { event.preventDefault(); fail(); });
    context = canvas.getContext("webgpu");
    if (!context) throw new Error("WebGPU canvas unavailable");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "premultiplied" });
    const shader = device.createShaderModule({ label: "AI Meeting voice orb", code: orbShaderSource });
    const compilation = await shader.getCompilationInfo();
    if (disposed) return null;
    if (compilation.messages.some(m => m.type === "error")) throw new Error("Orb shader compilation failed");
    const pipeline = await device.createRenderPipelineAsync({
      layout: "auto", vertex: { module: shader, entryPoint: "vs_main" },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    if (disposed) return null;
    const target = new Float32Array(orbUniformFloatCount);
    const values = new Float32Array(orbUniformFloatCount);
    uniform = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    let first = true;
    let phase = 0;
    return {
      dispose,
      draw(params, delta, reducedMotion) {
        if (disposed || !device || !context || !uniform) return;
        try {
          const size = Math.max(1, Math.min(512, Math.round(canvas.clientWidth * Math.min(devicePixelRatio || 1, 2))));
          if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size; }
          writeOrbUniforms(target, size, size, 0, params);
          const blend = first || reducedMotion ? 1 : 1 - Math.exp(-delta / (params.speed > values[3]! ? 0.22 : 0.65));
          for (let i = 3; i < values.length; i++) values[i] = values[i]! + (target[i]! - values[i]!) * blend;
          values[0] = size; values[1] = size;
          if (!reducedMotion) phase += delta * values[3]!;
          // Keep phase continuous when speed changes; zero speed freezes the current pose.
          const speed = Math.max(0.001, values[3]!);
          values[3] = speed;
          values[2] = (reducedMotion ? 1.2 : phase) / speed;
          first = false;
          device.queue.writeBuffer(uniform, 0, values);
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }] });
          pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
          device.queue.submit([encoder.finish()]);
        } catch { fail(); }
      },
    };
  } catch { fail(); return null; }
}
