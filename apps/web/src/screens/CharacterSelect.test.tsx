// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CharacterSelect } from "./CharacterSelect.js";
import { DEFAULT_SETTINGS } from "../state/settings.js";

it("keeps a way back while character data is still unavailable", () => {
  const html = renderToStaticMarkup(<CharacterSelect characters={[]} settings={DEFAULT_SETTINGS} dispatch={() => {}} broker={null} onDone={() => {}} />);
  expect(html).toContain("キャラクターがありません。");
  expect(html).toContain(">戻る</button>");
});
