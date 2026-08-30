import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
      // Model files: present only after scripts/fetch-sample-character.sh.
      const modelDir = join(dir, "model");
      const fetched = readdirSync(modelDir).some((f) => f.endsWith(".moc3"));
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
    });
  }
});
