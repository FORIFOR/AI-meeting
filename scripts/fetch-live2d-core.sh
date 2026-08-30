#!/usr/bin/env bash
# Downloads the Cubism Core runtime from Live2D's official CDN into vendor/live2d (git-ignored) so the
# web app can self-host it — required for privacyMode=strict_local, which forbids loading it from the CDN
# at runtime. Usage is subject to the Live2D Proprietary Software License Agreement.
# MotionSync Core is NOT available this way (BLOCKED_BY_MOTIONSYNC_CORE): download the MotionSync plugin manually.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/live2d"
mkdir -p "$DIR"
URL="https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"
curl -fsSL "$URL" -o "$DIR/live2dcubismcore.min.js"
echo "saved $DIR/live2dcubismcore.min.js ($(wc -c < "$DIR/live2dcubismcore.min.js") bytes)"
