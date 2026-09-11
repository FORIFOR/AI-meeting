# Third-party notices

Generated 2026-09-11T16:30:57.776Z by `scripts/licenses.mjs`. 434 npm packages.

## Non-OSS and specially licensed components (curated)

Reviewed 2026-09-12. Application-specific source code and documentation are licensed under [Apache-2.0](LICENSE). Third-party code, character assets, model weights and externally operated services retain their own terms. The [root notice](NOTICE) identifies the exceptions to the application license.

## Avatar runtime code

| Component | Pinned version | License / attribution | Distribution note |
|---|---|---|---|
| `@pixiv/three-vrm` and its modules | 3.5.5 | MIT; Copyright (c) 2019-2026 pixiv Inc. | Preserve the installed `LICENSE`; loaded models have separate licenses. |
| `three` | 0.185.1 | MIT; Copyright © 2010-2026 three.js authors | Preserve the installed `LICENSE`. |
| `wlipsync` | 1.3.1 | MIT; Copyright (c) 2021 hecomi; Copyright (c) 2024 Noeri Huisman | Preserve `LICENSE` with the JS/WASM. The copied sample calibration profile has an adjacent `wlipsync-profile.LICENSE`; it is not a Japanese-accuracy certification. |
| `pixi-live2d-display` | 0.4.0 | MIT; Copyright (c) 2020 Guan | Does not license Cubism Core or models. |
| `pixi.js` | 6.5.10 | MIT; Copyright (c) 2013-2017 Mathew Groves, Chad Engler | Preserve the installed `LICENSE`. |
| `@anam-ai/js-sdk` | 4.27.0; npm gitHead `a704c6b6a288a9f14af2d594851699cdc7aabd66` | npm and pinned package.json declare MIT; author Anam AI | Published tarball and source tree lack Anam's own license/notice text. `dist/umd/anam.js.LICENSE.txt` names buffer/ieee754 only. Upstream notice completeness remains unresolved. |

The first five rows' package licenses contain the following MIT permission and disclaimer. Preserve their copyright notices above with this text when distributing these components:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

This shared text does not supply the missing Anam-specific notice. Other dependencies retain their own license texts; the generated table is an inventory, not a replacement for those texts.

## Other browser runtime notices

| Component | Pinned version | Verified notice source / scope |
|---|---|---|
| `@mediapipe/tasks-vision` | 1.0.1; npm does not publish gitHead or repository for this version | Apache-2.0 is declared in the exact npm artifact. Its source maps retain Copyright The Closure Library Authors / Copyright Google LLC; declarations retain Copyright 2022 / 2023 The MediaPipe Authors. [License supplement](vendor/licenses/tasks-vision-LICENSE.txt) preserves these notices and the full text fetched from the Apache license URL explicitly named by the artifact. [Provenance and hashes](vendor/licenses/tasks-vision-SOURCE.json) record tarball integrity and matched installed files. No standalone license file was supplied by npm. This does not establish the package's upstream build commit or cover additional MediaPipe WASM/model assets. |
| `@digital-go-jp/design-tokens` | 2.0.1 | Installed `LICENSE` contains the full MIT text; Copyright (c) 2023 デジタル庁. LICENSE SHA-256 `9add7703fc9b3b9c8fe60608b141c5a56c5cba9ceafc257bca450852d153f6f3`. Preserve it with the emitted CSS. |

The MediaPipe JavaScript bundle supports optional local visual perception. No MediaPipe WASM or model assets were present in the inspected OSS build. Adding those assets requires an audit of their own exact artifacts and notices; this JavaScript supplement does not clear them.

## Character assets and Live2D components

| Component | Location / provenance | Applicable terms | Distribution status |
|---|---|---|---|
| Live2D Cubism Core | `vendor/live2d/live2dcubismcore.min.js`; official CDN; SHA-256 `25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f` | [Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) | Excluded from the published source and standard OSS browser build. Optional local installations must follow its terms; not MIT/Apache. |
| Cubism Web Samples / MotionSync Components | Reference commits `b1de66b0b1f1cb881d95fb6158622aeb6a2827bd` / `d974ec56bd1534bd365ed4d50fdbbe6d52660124` | [Live2D Open Software License](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html); Core and models are separately licensed | Reference checkouts are Git-ignored. MotionSync Core is not supplied by these open component repositories. |
| Yui = Hiyori / 桃瀬ひより; Haru = Haru; Reina = Mao / 虹色まお; Kei = Kei_basic | `characters/{yui,haru,reina,kei}/model`; pinned official copies | [Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_jp.html) + [per-model terms](https://www.live2d.com/learn/sample/model-terms/) | Model binaries are excluded from the published source and standard OSS browser build. Optional installations retain revenue-category, attribution, redistribution and use restrictions; Hiyori prohibits design modification. |
| Live2D-derived PNG/WebM/WebP previews | `apps/web/public/avatar-fallbacks/{yui,haru,reina}*` | Same source-character terms as the original models | Excluded from the published source and standard OSS browser build. Rendering a model into an image/video does not make it MIT/Apache/CC0. Permission to submit these images to another avatar service is not established. |
| `VRM1_Constraint_Twist_Sample` | `characters/vrm-sample/model.vrm`; official vrm-specification commit `821c11b250d8c70d5804ee13431e42bee56ea9c0`; SHA-256 `12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2` | [VRM Public License 1.0](https://vrm.dev/licenses/1.0/) + embedded `VRMC_vrm.meta`; (c) 2022 pixiv Inc. | Everyone avatar use, corporate commercial use, redistribution and modification/redistribution allowed; credit unnecessary. Antisocial/hate use disallowed. Retain metadata and SOURCE/license records; exclude from application code license. |
| VRoid `AvatarSample_A` | [Official Hub distribution](https://hub.vroid.com/characters/2843975675147313744/models/5644550979324015604) | [AvatarSample A-Z terms](https://vroid.pixiv.help/hc/ja/articles/4402394424089-AvatarSample-A-Z), updated 2024-12-26 | Optional candidate, not supplied by this audit. Official listing is VRM 0.0, not 1.0. Commercial use allowed subject to restrictions including no CC0 designation or sample-data character-creation service. Verify actual file metadata before distribution. |
| Sora / MPFB GLB and preview | `characters/sora/{model.glb,LICENSE.md,SOURCE.json}`, `avatar-fallbacks/sora.png`; source commit `eed58d198076a7e1e825f804802921c4d3804d46` | [Author's CC0 declaration for mpfb.glb](https://github.com/met4citizen/TalkingHead/blob/eed58d198076a7e1e825f804802921c4d3804d46/README.md), [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Git-tracked. Modified facial targets/textures recorded in SOURCE.json. Other upstream models have different terms. |

Live2D sample-character attribution for descriptions that accommodate it:

本作品のキャラクターには株式会社Live2Dの著作物であるサンプルデータが株式会社Live2Dの定める規約に従って用いられています。本作品は制作者の完全な自己の裁量で制作されています。

Arbitrary additional Live2D models may bring an application within the [expandable application category](https://www.live2d.com/sdk/license/expandable/), which requires review and agreement even for general/small-business users. This notice does not establish that the operator has such an agreement.

## Meeting transport and external services

| Component | Boundary | Terms / remaining scope |
|---|---|---|
| Attendee self-host and patches | `scripts/reality/attendee-selfhost/local-patches.diff`; documented measured base `c8f7761e55104186e502615da5737cc9d72fdfc2` | [Pinned LICENSE](https://github.com/attendee-labs/attendee/blob/c8f7761e55104186e502615da5737cc9d72fdfc2/LICENSE): Copyright (c) 2025 Attendee Labs, LLC; Elastic License 2.0. Full terms must accompany copied/modified portions; identify local modifications. ELv2 restricts hosted/managed services exposing substantial functionality. It is not an unrestricted OSS service grant. |
| Attendee Hosted | Connector/broker HTTP calls; deployment script targets `https://app.attendee.dev` | Separate Hosted service contract. Not evidence that this app deploys the pinned self-host code. Backend revision and customer contract were not inspected. |
| Anam Cara-4 / personas | Optional adapter and broker routes | [Service terms](https://anam.ai/terms-of-service) separately govern integration, key transfers, competitive benchmarking, prior human review and AI-persona disclosure. MIT SDK metadata does not license hosted models or submitted artwork. Applicable Order Form and custom-image rights remain separate. |
| Other cloud services | OpenAI, Gemini/Vertex, HeyGen, Tavus, Recall, LiveKit Cloud | Respective service terms and customer contracts. API access/data processing/media rights do not follow from the app's Apache-2.0 license. |

Attendee's local patch contains upstream code context. Preserve ELv2 when distributing that material or a patched server image, and do not apply the app's own license to it. The [Elastic ELv2 FAQ](https://www.elastic.co/licensing/elastic-license/faq) distinguishes internal application use from exposing substantial software functionality, but is not Attendee-specific commercial authorization.

## Existing non-avatar inventory (outside the focused 2026-09-12 review)

These entries retain prior inventory; exact shipped binaries, models and deployment obligations were not re-audited here.

| Component | Existing record | Distribution scope to verify |
|---|---|---|
| macOS `say` / AVSpeechSynthesizer voices | Apple macOS Software License Agreement | Applicable installed OS/voice terms before distributing generated product voices. |
| Style-Bert-VITS2 / voice models | Code AGPL-3.0; model-specific terms | Selected server/model and network-use obligations; HTTP separation alone is not clearance. |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later, optional sharp dependency | Notices and applicable corresponding-source/relinking obligations for actually distributed binaries; unused is not absent. |
| sherpa-onnx / SenseVoice / ReazonSpeech / Silero VAD | Apache-2.0 / FunAudioLLM Model License / Apache-2.0 / MIT respectively | Exact code/model files and required notices. |
| Gemma GGUF via llama.cpp | [Gemma Terms](https://ai.google.dev/gemma/terms); llama.cpp MIT | Selected model's distribution terms and version/source record. |
| Shippori Mincho, Zen Kaku Gothic, IBM Plex Mono | SIL Open Font License 1.1 | Font license texts with self-hosted fonts. |

The npm metadata scan cannot verify model rights, Hosted contracts, root-code ownership or missing upstream notices.


## npm packages

| Package | Version(s) | License |
|---|---|---|
| @anam-ai/js-sdk | 4.27.0 | MIT |
| @asamuzakjp/css-color | 3.2.0 | MIT |
| @babel/code-frame | 7.29.7 | MIT |
| @babel/compat-data | 7.29.7 | MIT |
| @babel/core | 7.29.7 | MIT |
| @babel/generator | 7.29.8 | MIT |
| @babel/helper-compilation-targets | 7.29.7 | MIT |
| @babel/helper-globals | 7.29.7 | MIT |
| @babel/helper-module-imports | 7.29.7 | MIT |
| @babel/helper-module-transforms | 7.29.7 | MIT |
| @babel/helper-plugin-utils | 7.29.7 | MIT |
| @babel/helper-string-parser | 7.29.7 | MIT |
| @babel/helper-validator-identifier | 7.29.7 | MIT |
| @babel/helper-validator-option | 7.29.7 | MIT |
| @babel/helpers | 7.29.7 | MIT |
| @babel/parser | 7.29.8 | MIT |
| @babel/plugin-transform-react-jsx-self | 7.29.7 | MIT |
| @babel/plugin-transform-react-jsx-source | 7.29.7 | MIT |
| @babel/runtime | 7.29.7 | MIT |
| @babel/template | 7.29.7 | MIT |
| @babel/traverse | 7.29.8 | MIT |
| @babel/types | 7.29.8 | MIT |
| @bufbuild/protobuf | 1.10.1 | (Apache-2.0 AND BSD-3-Clause) |
| @csstools/color-helpers | 5.1.0 | MIT-0 |
| @csstools/css-calc | 2.1.4 | MIT |
| @csstools/css-color-parser | 3.1.0 | MIT |
| @csstools/css-parser-algorithms | 3.0.5 | MIT |
| @csstools/css-tokenizer | 3.0.4 | MIT |
| @daily-co/daily-js | 0.92.2 | BSD-2-Clause |
| @digital-go-jp/design-tokens | 2.0.1 | MIT |
| @dimforge/rapier3d-compat | 0.12.0 | Apache-2.0 |
| @esbuild/darwin-arm64 | 0.28.2 | MIT |
| @google-cloud/firestore | 9.0.1 | Apache-2.0 |
| @google-cloud/firestore-api | 0.2.0 | Apache-2.0 |
| @grpc/grpc-js | 1.14.4 | Apache-2.0 |
| @grpc/proto-loader | 0.8.1 | Apache-2.0 |
| @hono/node-server | 2.1.1 | MIT |
| @huggingface/jinja | 0.5.9 | MIT |
| @huggingface/tokenizers | 0.1.3 | Apache-2.0 |
| @huggingface/transformers | 4.2.0 | Apache-2.0 |
| @img/colour | 1.1.0 | MIT |
| @img/sharp-darwin-arm64 | 0.34.5 | Apache-2.0 |
| @img/sharp-libvips-darwin-arm64 | 1.2.4 | LGPL-3.0-or-later |
| @isaacs/cliui | 8.0.2 | ISC |
| @jridgewell/gen-mapping | 0.3.13 | MIT |
| @jridgewell/remapping | 2.3.5 | MIT |
| @jridgewell/resolve-uri | 3.1.2 | MIT |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT |
| @jridgewell/trace-mapping | 0.3.31 | MIT |
| @js-sdsl/ordered-map | 4.4.2 | MIT |
| @livekit/mutex | 1.1.1 | Apache-2.0 |
| @livekit/protocol | 1.50.4, 1.51.0 | Apache-2.0 |
| @mediapipe/tasks-vision | 1.0.1 | Apache-2.0 |
| @opentelemetry/api | 1.9.1 | Apache-2.0 |
| @pixi/accessibility | 6.5.10 | MIT |
| @pixi/app | 6.5.10 | MIT |
| @pixi/compressed-textures | 6.5.10 | MIT |
| @pixi/constants | 6.5.10 | MIT |
| @pixi/core | 6.5.10 | MIT |
| @pixi/display | 6.5.10 | MIT |
| @pixi/extensions | 6.5.10 | MIT |
| @pixi/extract | 6.5.10 | MIT |
| @pixi/filter-alpha | 6.5.10 | MIT |
| @pixi/filter-blur | 6.5.10 | MIT |
| @pixi/filter-color-matrix | 6.5.10 | MIT |
| @pixi/filter-displacement | 6.5.10 | MIT |
| @pixi/filter-fxaa | 6.5.10 | MIT |
| @pixi/filter-noise | 6.5.10 | MIT |
| @pixi/graphics | 6.5.10 | MIT |
| @pixi/interaction | 6.5.10 | MIT |
| @pixi/loaders | 6.5.10 | MIT |
| @pixi/math | 6.5.10 | MIT |
| @pixi/mesh | 6.5.10 | MIT |
| @pixi/mesh-extras | 6.5.10 | MIT |
| @pixi/mixin-cache-as-bitmap | 6.5.10 | MIT |
| @pixi/mixin-get-child-by-name | 6.5.10 | MIT |
| @pixi/mixin-get-global-position | 6.5.10 | MIT |
| @pixi/particle-container | 6.5.10 | MIT |
| @pixi/polyfill | 6.5.10 | MIT |
| @pixi/prepare | 6.5.10 | MIT |
| @pixi/runner | 6.5.10 | MIT |
| @pixi/settings | 6.5.10 | MIT |
| @pixi/sprite | 6.5.10 | MIT |
| @pixi/sprite-animated | 6.5.10 | MIT |
| @pixi/sprite-tiling | 6.5.10 | MIT |
| @pixi/spritesheet | 6.5.10 | MIT |
| @pixi/text | 6.5.10 | MIT |
| @pixi/text-bitmap | 6.5.10 | MIT |
| @pixi/ticker | 6.5.10 | MIT |
| @pixi/utils | 6.5.10 | MIT |
| @pixiv/three-vrm | 3.5.5 | MIT |
| @pixiv/three-vrm-core | 3.5.5 | MIT |
| @pixiv/three-vrm-materials-hdr-emissive-multiplier | 3.5.5 | MIT |
| @pixiv/three-vrm-materials-mtoon | 3.5.5 | MIT |
| @pixiv/three-vrm-materials-v0compat | 3.5.5 | MIT |
| @pixiv/three-vrm-node-constraint | 3.5.5 | MIT |
| @pixiv/three-vrm-springbone | 3.5.5 | MIT |
| @pixiv/types-vrm-0.0 | 3.5.5 | MIT |
| @pixiv/types-vrmc-materials-hdr-emissive-multiplier-1.0 | 3.5.5 | MIT |
| @pixiv/types-vrmc-materials-mtoon-1.0 | 3.5.5 | MIT |
| @pixiv/types-vrmc-node-constraint-1.0 | 3.5.5 | MIT |
| @pixiv/types-vrmc-springbone-1.0 | 3.5.5 | MIT |
| @pixiv/types-vrmc-springbone-extended-collider-1.0 | 3.5.5 | MIT |
| @pixiv/types-vrmc-vrm-1.0 | 3.5.5 | MIT |
| @pkgjs/parseargs | 0.11.0 | MIT |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause |
| @protobufjs/codegen | 2.0.5 | BSD-3-Clause |
| @protobufjs/eventemitter | 1.1.1 | BSD-3-Clause |
| @protobufjs/fetch | 1.1.1 | BSD-3-Clause |
| @protobufjs/float | 1.0.2 | BSD-3-Clause |
| @protobufjs/path | 1.1.2 | BSD-3-Clause |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause |
| @protobufjs/utf8 | 1.1.2 | BSD-3-Clause |
| @puppeteer/browsers | 3.2.1 | Apache-2.0 |
| @rolldown/pluginutils | 1.0.0-rc.3 | MIT |
| @rollup/rollup-darwin-arm64 | 4.63.1 | MIT |
| @sentry-internal/browser-utils | 8.55.2 | MIT |
| @sentry-internal/feedback | 8.55.2 | MIT |
| @sentry-internal/replay | 8.55.2 | MIT |
| @sentry-internal/replay-canvas | 8.55.2 | MIT |
| @sentry/browser | 8.55.2 | MIT |
| @sentry/core | 8.55.2 | MIT |
| @tauri-apps/cli | 2.11.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-darwin-arm64 | 2.11.4 | Apache-2.0 OR MIT |
| @tweenjs/tween.js | 23.1.3 | MIT |
| @types/babel__core | 7.20.5 | MIT |
| @types/babel__generator | 7.27.0 | MIT |
| @types/babel__template | 7.4.4 | MIT |
| @types/babel__traverse | 7.28.0 | MIT |
| @types/chai | 5.2.3 | MIT |
| @types/deep-eql | 4.0.2 | MIT |
| @types/dom-mediacapture-record | 1.0.22 | MIT |
| @types/earcut | 2.1.4 | MIT |
| @types/estree | 1.0.9 | MIT |
| @types/node | 24.13.3 | MIT |
| @types/offscreencanvas | 2019.7.3 | MIT |
| @types/react | 19.2.18 | MIT |
| @types/react-dom | 19.2.5 | MIT |
| @types/stats.js | 0.17.4 | MIT |
| @types/three | 0.185.0 | MIT |
| @types/webxr | 0.5.24 | MIT |
| @types/ws | 8.18.1 | MIT |
| @vitejs/plugin-react | 5.2.0 | MIT |
| @vitest/expect | 3.2.7 | MIT |
| @vitest/mocker | 3.2.7 | MIT |
| @vitest/pretty-format | 3.2.7 | MIT |
| @vitest/runner | 3.2.7 | MIT |
| @vitest/snapshot | 3.2.7 | MIT |
| @vitest/spy | 3.2.7 | MIT |
| @vitest/utils | 3.2.7 | MIT |
| adm-zip | 0.6.0 | MIT |
| agent-base | 7.1.4 | MIT |
| ansi-regex | 5.0.1, 6.3.0 | MIT |
| ansi-styles | 4.3.0, 6.2.3 | MIT |
| argparse | 2.0.1 | Python-2.0 |
| array-union | 1.0.2 | MIT |
| array-uniq | 1.0.3 | MIT |
| assertion-error | 2.0.1 | MIT |
| async | 2.6.4 | MIT |
| balanced-match | 1.0.2 | MIT |
| base64-js | 1.5.1 | MIT |
| baseline-browser-mapping | 2.11.20 | Apache-2.0 |
| bignumber.js | 9.3.1 | MIT |
| bowser | 2.14.1 | MIT |
| brace-expansion | 1.1.18, 2.1.4 | MIT |
| browserslist | 4.28.8 | MIT |
| buffer | 6.0.3 | MIT |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause |
| cac | 6.7.14 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| caniuse-lite | 1.0.30001810 | CC-BY-4.0 |
| chai | 5.3.3 | MIT |
| chalk | 4.1.2 | MIT |
| check-error | 2.1.3 | MIT |
| chromium-bidi | 17.0.2 | Apache-2.0 |
| cliui | 8.0.1, 9.0.1 | ISC |
| color-convert | 2.0.1 | MIT |
| color-name | 1.1.4 | MIT |
| commander | 2.20.3 | MIT |
| commondir | 1.0.1 | MIT |
| concat-map | 0.0.1 | MIT |
| concurrently | 9.2.4 | MIT |
| convert-source-map | 2.0.0 | MIT |
| cross-spawn | 7.0.6 | MIT |
| cssstyle | 4.6.0 | MIT |
| csstype | 3.2.3 | MIT |
| data-uri-to-buffer | 4.0.1 | MIT |
| data-urls | 5.0.0 | MIT |
| debug | 4.4.3 | MIT |
| decimal.js | 10.6.0 | MIT |
| deep-eql | 5.0.2 | MIT |
| define-data-property | 1.1.4 | MIT |
| define-properties | 1.2.1 | MIT |
| dequal | 2.0.3 | MIT |
| detect-libc | 2.1.2 | Apache-2.0 |
| devtools-protocol | 0.0.1666840 | BSD-3-Clause |
| dunder-proto | 1.0.1 | MIT |
| duplexify | 4.1.3 | MIT |
| earcut | 2.2.4 | ISC |
| eastasianwidth | 0.2.0 | MIT |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 |
| electron-to-chromium | 1.5.416 | ISC |
| email-addresses | 3.1.0 | MIT |
| emoji-regex | 8.0.0, 9.2.2, 10.6.0 | MIT |
| end-of-stream | 1.4.5 | MIT |
| entities | 6.0.1 | BSD-2-Clause |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-module-lexer | 1.7.0 | MIT |
| es-object-atoms | 1.1.2 | MIT |
| esbuild | 0.28.2 | MIT |
| escalade | 3.2.0 | MIT |
| escape-string-regexp | 1.0.5, 4.0.0 | MIT |
| estree-walker | 3.0.3 | MIT |
| eventemitter3 | 3.1.2 | MIT |
| events | 3.3.0 | MIT |
| expect-type | 1.4.0 | Apache-2.0 |
| extend | 3.0.2 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fdir | 6.5.0 | MIT |
| fetch-blob | 3.2.0 | MIT |
| fflate | 0.8.3 | MIT |
| fft.js | 4.0.4 | MIT |
| filename-reserved-regex | 2.0.0 | MIT |
| filenamify | 4.3.0 | MIT |
| find-cache-dir | 3.3.2 | MIT |
| find-up | 4.1.0 | MIT |
| flatbuffers | 25.9.23 | Apache-2.0 |
| foreground-child | 3.3.1 | ISC |
| formdata-polyfill | 4.0.10 | MIT |
| fs-extra | 8.1.0 | MIT |
| fs.realpath | 1.0.0 | ISC |
| fsevents | 2.3.3 | MIT |
| function-bind | 1.1.2 | MIT |
| functional-red-black-tree | 1.0.1 | MIT |
| gaxios | 7.1.3, 7.3.1 | Apache-2.0 |
| gcp-metadata | 8.1.4, 9.0.3 | Apache-2.0 |
| gensync | 1.0.0-beta.2 | MIT |
| get-caller-file | 2.0.5 | ISC |
| get-east-asian-width | 1.6.0 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| gh-pages | 4.0.0 | MIT |
| glob | 7.2.3, 10.5.0 | ISC |
| global-agent | 4.1.3 | BSD-3-Clause |
| globalthis | 1.0.4 | MIT |
| globby | 6.1.0 | MIT |
| google-auth-library | 10.5.0, 11.0.2 | Apache-2.0 |
| google-gax | 5.0.8, 6.2.0 | Apache-2.0 |
| google-logging-utils | 1.1.3, 2.0.1 | Apache-2.0 |
| gopd | 1.2.0 | MIT |
| graceful-fs | 4.2.11 | ISC |
| gtoken | 8.0.0 | MIT |
| guid-typescript | 1.0.9 | ISC |
| has-flag | 4.0.0 | MIT |
| has-property-descriptors | 1.0.2 | MIT |
| has-symbols | 1.1.0 | MIT |
| hasown | 2.0.4 | MIT |
| hono | 4.13.5 | MIT |
| html-encoding-sniffer | 4.0.0 | MIT |
| http-proxy-agent | 7.0.2 | MIT |
| https-proxy-agent | 7.0.6 | MIT |
| iconv-lite | 0.6.3 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |
| inflight | 1.0.6 | ISC |
| inherits | 2.0.4 | ISC |
| is-fullwidth-code-point | 3.0.0 | MIT |
| is-potential-custom-element-name | 1.0.1 | MIT |
| isexe | 2.0.0 | ISC |
| jackspeak | 3.4.3 | BlueOak-1.0.0 |
| jose | 5.10.0, 6.2.10 | MIT |
| js-tokens | 4.0.0, 9.0.1 | MIT |
| js-yaml | 5.4.1 | MIT |
| jsdom | 26.1.0 | MIT |
| jsesc | 3.1.0 | MIT |
| json-bigint | 1.0.0 | MIT |
| json5 | 2.2.3 | MIT |
| jsonfile | 4.0.0 | MIT |
| jwa | 2.0.1 | MIT |
| jws | 4.0.1 | MIT |
| livekit-client | 2.22.1 | Apache-2.0 |
| livekit-server-sdk | 2.19.0 | Apache-2.0 |
| locate-path | 5.0.0 | MIT |
| lodash | 4.18.1 | MIT |
| lodash.camelcase | 4.3.0 | MIT |
| loglevel | 1.9.2 | MIT |
| long | 5.3.2 | Apache-2.0 |
| loupe | 3.2.1 | MIT |
| lru-cache | 5.1.1, 10.4.3 | ISC |
| machina | 7.0.1 | (MIT OR GPL) |
| magic-string | 0.30.21 | MIT |
| make-dir | 3.1.0 | MIT |
| matcher | 4.0.0 | MIT |
| math-intrinsics | 1.1.0 | MIT |
| meshoptimizer | 1.1.1 | MIT |
| minimatch | 3.1.5, 9.0.9 | ISC |
| minipass | 7.1.3 | BlueOak-1.0.0 |
| mitt | 3.0.1 | MIT |
| modern-tar | 0.8.4 | MIT |
| ms | 2.1.3 | MIT |
| nanoid | 3.3.18 | MIT |
| node-domexception | 1.0.0 | MIT |
| node-fetch | 3.3.2 | MIT |
| node-releases | 2.0.54 | MIT |
| nwsapi | 2.2.26 | MIT |
| object-assign | 4.1.1 | MIT |
| object-hash | 3.0.0 | MIT |
| object-inspect | 1.13.4 | MIT |
| object-keys | 1.1.1 | MIT |
| once | 1.4.0 | ISC |
| onnxruntime-common | 1.24.0-dev.20251116-b39e144322, 1.29.0 | MIT |
| onnxruntime-node | 1.29.0 | MIT |
| onnxruntime-web | 1.26.0-dev.20260416-b7804b056c | MIT |
| p-limit | 2.3.0 | MIT |
| p-locate | 4.1.0 | MIT |
| p-try | 2.2.0 | MIT |
| package-json-from-dist | 1.0.1 | BlueOak-1.0.0 |
| parse5 | 7.3.0 | MIT |
| path-exists | 4.0.0 | MIT |
| path-is-absolute | 1.0.1 | MIT |
| path-key | 3.1.1 | MIT |
| path-scurry | 1.11.1 | BlueOak-1.0.0 |
| pathe | 2.0.3 | MIT |
| pathval | 2.0.1 | MIT |
| picocolors | 1.1.1 | ISC |
| picomatch | 4.0.7 | MIT |
| pify | 2.3.0 | MIT |
| pinkie | 2.0.4 | MIT |
| pinkie-promise | 2.0.1 | MIT |
| pixi-live2d-display | 0.4.0 | MIT |
| pixi.js | 6.5.10 | MIT |
| pkg-dir | 4.2.0 | MIT |
| platform | 1.3.6 | MIT |
| postcss | 8.5.26 | MIT |
| promise-polyfill | 8.3.0 | MIT |
| proto3-json-serializer | 3.0.4, 4.0.2 | Apache-2.0 |
| protobufjs | 7.6.6 | BSD-3-Clause |
| punycode | 1.4.1, 2.3.1 | MIT |
| puppeteer-core | 25.9.0 | Apache-2.0 |
| qs | 6.15.3 | BSD-3-Clause |
| react | 19.2.8 | MIT |
| react-dom | 19.2.8 | MIT |
| react-refresh | 0.18.0 | MIT |
| readable-stream | 3.6.2 | MIT |
| require-directory | 2.1.1 | MIT |
| retry-request | 8.0.4, 9.0.1 | MIT |
| rimraf | 5.0.10 | ISC |
| rollup | 4.63.1 | MIT |
| rrweb-cssom | 0.8.0 | MIT |
| rxjs | 7.8.2 | Apache-2.0 |
| safe-buffer | 5.2.1 | MIT |
| safer-buffer | 2.1.2 | MIT |
| saxes | 6.0.0 | ISC |
| scheduler | 0.27.0 | MIT |
| sdp | 3.2.2 | MIT |
| sdp-transform | 2.15.0 | MIT |
| semver | 6.3.1, 7.8.5 | ISC |
| serialize-error | 8.1.0 | MIT |
| sharp | 0.34.5 | Apache-2.0 |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| shell-quote | 1.9.0 | MIT |
| sherpa-onnx-darwin-arm64 | 1.13.7 | Apache-2.0 |
| sherpa-onnx-node | 1.13.7 | Apache-2.0 |
| side-channel | 1.1.1 | MIT |
| side-channel-list | 1.0.1 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| siginfo | 2.0.0 | ISC |
| signal-exit | 4.1.0 | ISC |
| source-map-js | 1.2.1 | BSD-3-Clause |
| stackback | 0.0.2 | MIT |
| std-env | 3.10.0 | MIT |
| stream-events | 1.0.5 | MIT |
| stream-shift | 1.0.3 | MIT |
| string_decoder | 1.3.0 | MIT |
| string-width | 4.2.3, 5.1.2, 7.2.0, 8.2.2 | MIT |
| strip-ansi | 6.0.1, 7.2.0 | MIT |
| strip-literal | 3.1.0 | MIT |
| strip-outer | 1.0.1 | MIT |
| stubs | 3.0.0 | MIT |
| supports-color | 7.2.0, 8.1.1 | MIT |
| symbol-tree | 3.2.4 | MIT |
| teeny-request | 10.1.4, 11.0.1 | Apache-2.0 |
| three | 0.185.1 | MIT |
| tinybench | 2.9.0 | MIT |
| tinyexec | 0.3.2 | MIT |
| tinyglobby | 0.2.17 | MIT |
| tinypool | 1.1.1 | MIT |
| tinyrainbow | 2.0.0 | MIT |
| tinyspy | 4.0.4 | MIT |
| tldts | 6.1.86 | MIT |
| tldts-core | 6.1.86 | MIT |
| tough-cookie | 5.1.2 | BSD-3-Clause |
| tr46 | 5.1.1 | MIT |
| tree-kill | 1.2.2 | MIT |
| trim-repeated | 1.0.0 | MIT |
| tslib | 2.8.1 | 0BSD |
| tsx | 4.23.12, 4.23.13 | MIT |
| type-fest | 0.20.2 | (MIT OR CC0-1.0) |
| typed-emitter | 2.1.0 | MIT |
| typed-query-selector | 2.12.2 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| undici-types | 7.18.2 | MIT |
| universalify | 0.1.2 | MIT |
| update-browserslist-db | 1.3.2 | MIT |
| url | 0.11.4 | MIT |
| util-deprecate | 1.0.2 | MIT |
| vite | 7.3.6 | MIT |
| vite-node | 3.2.4 | MIT |
| vitest | 3.2.7 | MIT |
| w3c-xmlserializer | 5.0.0 | MIT |
| web-streams-polyfill | 3.3.3 | MIT |
| webdriver-bidi-protocol | 0.4.2 | Apache-2.0 |
| webidl-conversions | 7.0.0 | BSD-2-Clause |
| webrtc-adapter | 9.0.6 | BSD-3-Clause |
| whatwg-encoding | 3.1.1 | MIT |
| whatwg-mimetype | 4.0.0 | MIT |
| whatwg-url | 14.2.0 | MIT |
| which | 2.0.2 | ISC |
| why-is-node-running | 2.3.0 | MIT |
| wlipsync | 1.3.1 | MIT |
| wrap-ansi | 7.0.0, 8.1.0, 9.0.2 | MIT |
| wrappy | 1.0.2 | ISC |
| ws | 8.21.3 | MIT |
| xml-name-validator | 5.0.0 | Apache-2.0 |
| xmlchars | 2.2.0 | MIT |
| y18n | 5.0.8 | ISC |
| yallist | 3.1.1 | ISC |
| yargs | 17.7.2, 18.1.0 | MIT |
| yargs-parser | 21.1.1, 22.0.0 | ISC |
| zod | 3.25.76 | MIT |
