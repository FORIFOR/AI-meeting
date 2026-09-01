#!/usr/bin/env bash
# Downloads Pipecat's Smart Turn v3 into vendor/smart-turn (git-ignored). Without it the agent falls
# back to silence + text endpointing and says so (BLOCKED_BY_SMART_TURN) rather than pretending to
# have an acoustic opinion. Apache-2.0, from the pipecat-ai org on Hugging Face.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/smart-turn"
mkdir -p "$DIR"
URL="https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.0.onnx"
[ -f "$DIR/smart-turn-v3.0.onnx" ] || curl -fsSL "$URL" -o "$DIR/smart-turn-v3.0.onnx"
echo "saved $DIR/smart-turn-v3.0.onnx ($(wc -c < "$DIR/smart-turn-v3.0.onnx") bytes)"
