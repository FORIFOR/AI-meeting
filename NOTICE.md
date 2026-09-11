# NOTICE — component, model and service licenses

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
