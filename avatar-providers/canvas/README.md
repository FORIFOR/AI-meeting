# @rcai/avatar-canvas — DEV / DEBUG renderer

Draws a stylised 2D face from the canonical `AvatarParams` produced by `MotionStackAvatarBase`
(same state machine, motion stack, lip sync and behaviour as the Live2D provider).

Use it to inspect behaviour without a licensed model. **It is not a product avatar and never
counts as Gate 2 (Live2D) evidence.** The canvas prints a "DEBUG RENDERER" caption.

```ts
const avatar = new CanvasAvatarProvider({ container: document.getElementById("stage")! });
await avatar.prepare(characterDefinition);
await avatar.start();
```
