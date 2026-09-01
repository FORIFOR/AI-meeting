#!/usr/bin/env bash
# Downloads Google's Face Landmarker model into vendor/mediapipe (git-ignored) and copies it, with the
# WASM runtime that ships in @mediapipe/tasks-vision, into apps/web/public/mediapipe so the bot page can
# self-host both. Nothing is loaded from a CDN at runtime: the page runs inside a meeting vendor's
# browser, and a page that only works when a third-party CDN is reachable is a page that fails in a call.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/vendor/mediapipe"
PUB="$ROOT/apps/web/public/mediapipe"
mkdir -p "$DIR" "$PUB/wasm"

MODEL_URL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
if [ ! -f "$DIR/face_landmarker.task" ]; then
  curl -fsSL "$MODEL_URL" -o "$DIR/face_landmarker.task"
fi
cp "$DIR/face_landmarker.task" "$PUB/face_landmarker.task"

# The package does not export ./package.json, so resolve the directory rather than asking node for it.
WASM_SRC="$ROOT/apps/web/node_modules/@mediapipe/tasks-vision/wasm"
[ -d "$WASM_SRC" ] || { echo "BLOCKED_BY_MEDIAPIPE_PKG: run pnpm install first ($WASM_SRC missing)" >&2; exit 1; }
cp "$WASM_SRC"/*.wasm "$WASM_SRC"/*.js "$PUB/wasm/"
# The ES bundle too, so the model can be exercised from a plain page (verification, and any page that
# is not built by Vite) without reaching for a CDN.
cp "$WASM_SRC/../vision_bundle.mjs" "$PUB/vision_bundle.mjs"
echo "model  $PUB/face_landmarker.task ($(wc -c < "$PUB/face_landmarker.task") bytes)"
echo "wasm   $PUB/wasm ($(ls "$PUB/wasm" | wc -l | tr -d ' ') files)"
