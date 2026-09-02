#!/usr/bin/env bash
# Downloads Supertonic 3 (Supertone, model openrail / code MIT) into vendor/supertonic — git-ignored.
# Local, on-device TTS: nothing leaves the machine at synthesis time. Without it the agent says
# BLOCKED_BY_SUPERTONIC and uses another engine rather than pretending to have one.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/supertonic"
HF="https://huggingface.co/Supertone/supertonic-3/resolve/main"
GH="https://raw.githubusercontent.com/supertone-inc/supertonic/main/nodejs"
mkdir -p "$DIR/onnx" "$DIR/voice_styles"

for f in duration_predictor.onnx text_encoder.onnx vector_estimator.onnx vocoder.onnx tts.json unicode_indexer.json; do
  [ -f "$DIR/onnx/$f" ] || curl -fsSL "$HF/onnx/$f" -o "$DIR/onnx/$f"
done
for v in F1 F2 F3 F4 F5 M1 M2 M3 M4 M5; do
  [ -f "$DIR/voice_styles/$v.json" ] || curl -fsSL "$HF/voice_styles/$v.json" -o "$DIR/voice_styles/$v.json"
done
# The vendor's own Node inference, used as-is: this is a four-model pipeline and a reimplementation
# would be a guess. MIT, Copyright (c) 2025 Supertone Inc.
curl -fsSL "$GH/helper.js" -o "$DIR/helper.js"
curl -fsSL "https://raw.githubusercontent.com/supertone-inc/supertonic/main/LICENSE" -o "$DIR/LICENSE"
# The vendor's helper imports onnxruntime-node / fft.js / js-yaml by bare specifier, and it lives
# outside any package. A link to the agent's modules is what makes those resolve without copying the
# file into source or vendoring three more dependencies.
ln -sfn ../../services/agent/node_modules "$DIR/node_modules"
echo "supertonic in $DIR ($(du -sh "$DIR" | cut -f1))"
