import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCharacterDefinition, DEFAULT_EXPRESSIONS, createDefaultMotions } from "@rcai/avatar-core";
import { characters } from "./index.js";

const root = dirname(fileURLToPath(import.meta.url));
const clipIds = new Set(createDefaultMotions().map((c) => c.id));

describe("character packs", () => {
  for (const entry of characters) {
    it(`${entry.id} validates and references known motions/expressions`, () => {
      const dir = join(root, entry.id);
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      const character = JSON.parse(readFileSync(join(dir, "character.json"), "utf8"));
      const def = buildCharacterDefinition(manifest, character, entry.baseUrl);
      expect(def.manifest.id).toBe(entry.id);
      expect(def.manifest.renderer).toBe(entry.renderer);
      expect(def.manifest.defaultPersona).toBe(entry.defaultPersona);
      expect(def.voice.voices.openai && def.voice.voices.google && def.voice.voices.local).toBeTruthy();
      for (const ids of Object.values(def.motions)) for (const id of ids ?? []) expect(clipIds.has(id), `unknown clip ${id}`).toBe(true);
      for (const emotion of Object.keys(def.expressions)) expect(emotion in DEFAULT_EXPRESSIONS, `unknown emotion ${emotion}`).toBe(true);
      if (entry.renderer === "live2d") {
        // Live2D model files are present only after scripts/fetch-sample-character.sh.
        const modelDir = join(dir, "model");
        const fetched = existsSync(modelDir) && readdirSync(modelDir).some((f) => f.endsWith(".moc3"));
        if (fetched) {
          expect(existsSync(join(dir, def.model))).toBe(true);
          const model3 = JSON.parse(readFileSync(join(dir, def.model), "utf8"));
          expect(existsSync(join(dirname(join(dir, def.model)), model3.FileReferences.Moc))).toBe(true);
          // File-based expressions must exist in the model3.json expression list.
          const names = new Set((model3.FileReferences.Expressions ?? []).map((e: { Name: string }) => e.Name));
          for (const v of Object.values(def.expressions)) if (typeof v === "string") expect(names.has(v), `expression ${v}`).toBe(true);
        } else {
          console.warn(`[characters] ${entry.id}: model not fetched (run scripts/fetch-sample-character.sh)`);
        }
      } else if (entry.renderer === "vrm") {
        const data = readFileSync(join(dir, def.model));
        expect(data.toString("ascii", 0, 4)).toBe("glTF");
        expect(data.readUInt32LE(8)).toBe(data.length);
        const gltf = JSON.parse(data.toString("utf8", 20, 20 + data.readUInt32LE(12)));
        expect(gltf.extensions.VRMC_vrm.specVersion).toBe("1.0");
        expect(gltf.extensions.VRMC_vrm.meta.allowRedistribution).toBe(true);
        for (const vowel of ["aa", "ih", "ou", "ee", "oh"]) expect(gltf.extensions.VRMC_vrm.expressions.preset[vowel]).toBeTruthy();
        const resources = [...(gltf.buffers ?? []), ...(gltf.images ?? [])];
        expect(resources.filter((resource: { uri?: string }) => resource.uri && !resource.uri.startsWith("data:"))).toEqual([]);
        const source = JSON.parse(readFileSync(join(dir, "SOURCE.json"), "utf8"));
        expect(createHash("sha256").update(data).digest("hex")).toBe(source.sha256);
      } else if (entry.renderer === "human-glb") {
        // Bundled GLBs are required, including the binary payload (not a Git LFS pointer).
        const modelPath = join(dir, def.model);
        expect(existsSync(modelPath), `${entry.id}: bundled GLB missing`).toBe(true);
        const glb = readFileSync(modelPath);
        expect(glb.length).toBeGreaterThan(20);
        expect(glb.toString("ascii", 0, 4)).toBe("glTF");
        expect(glb.readUInt32LE(4), "GLB version").toBe(2);
        expect(glb.readUInt32LE(8), "GLB declared length").toBe(glb.length);
        expect(glb.toString("ascii", 16, 20), "first GLB chunk").toBe("JSON");
        const jsonLength = glb.readUInt32LE(12);
        expect(20 + jsonLength).toBeLessThanOrEqual(glb.length);
        const gltf = JSON.parse(glb.toString("utf8", 20, 20 + jsonLength));
        expect(gltf.asset.version).toBe("2.0");
        expect(gltf.meshes.length, "bundled avatar meshes").toBeGreaterThan(0);
      }
    });
  }
});
