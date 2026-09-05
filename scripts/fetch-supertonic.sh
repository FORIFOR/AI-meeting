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
# One patch to the vendor's file: it throws on any non-CPU request ("GPU mode is not supported yet"),
# which on this platform means refusing CoreML — a provider onnxruntime-node already bundles. The opts
# object it builds is passed straight to session creation, so honouring executionProviders is enough.
python3 - "$DIR/helper.js" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
old = """    if (useGpu) {
        throw new Error('GPU mode is not supported yet');
    } else {
        console.log('Using CPU for inference');
    }"""
new = """    if (useGpu) {
        opts.executionProviders = Array.isArray(useGpu) ? useGpu : ['coreml', 'cpu'];
        console.log('Using', opts.executionProviders.join(','), 'for inference');
    } else {
        console.log('Using CPU for inference');
    }"""
if old in s:
    s = s.replace(old, new, 1)
    print("helper: execution providers enabled")
else:
    print("helper: patch point not found — upstream changed, leaving as-is")
# Second patch: let the caller pass ONNX Runtime session options. The runtime's default thread pool
# spans all ten cores, efficiency cores included, and every op waits for the slowest thread; with the
# bot's browser saturating the host, four threads synthesise 15–20 % sooner (agent config, SUPERTONIC_THREADS).
old2 = """export async function loadTextToSpeech(onnxDir, useGpu = false) {
    const opts = {};"""
new2 = """export async function loadTextToSpeech(onnxDir, useGpu = false, sessionOptions = {}) {
    const opts = { ...sessionOptions };"""
if old2 in s:
    s = s.replace(old2, new2, 1)
    print("helper: session options accepted")
else:
    print("helper: session-options patch point not found — upstream changed, leaving as-is")
p.write_text(s)
PYEOF
curl -fsSL "https://raw.githubusercontent.com/supertone-inc/supertonic/main/LICENSE" -o "$DIR/LICENSE"
# The vendor's helper imports onnxruntime-node / fft.js / js-yaml by bare specifier, and it lives
# outside any package. A link to the agent's modules is what makes those resolve without copying the
# file into source or vendoring three more dependencies.
ln -sfn ../../services/agent/node_modules "$DIR/node_modules"
echo "supertonic in $DIR ($(du -sh "$DIR" | cut -f1))"
