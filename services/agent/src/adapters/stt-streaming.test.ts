import { expect, it } from "vitest";
import { IncrementalOfflineSTT } from "./stt-streaming.js";

it("never publishes a queued decode from an earlier utterance, even when the new buffer is longer", async () => {
  const pending: ((text: string) => void)[] = [];
  const stt = new IncrementalOfflineSTT({
    engine: "test", ready: true, model: "test",
    transcribe: () => new Promise<string>(resolve => pending.push(resolve)),
  });
  const observed: string[] = [];
  stt.onTranscript(event => observed.push(event.text));
  stt.start("ja");
  stt.pushAudio(new Float32Array(6400));
  const oldFinal = stt.endUtterance();
  stt.start("ja");
  stt.pushAudio(new Float32Array(9600));
  pending.shift()!("前の発話");
  expect((await oldFinal).text).toBe("");
  expect(observed).toEqual([]);
  const current = stt.endUtterance();
  pending.shift()!("新しい発話");
  expect((await current).text).toBe("新しい発話");
  expect(observed).not.toContain("前の発話");
});
