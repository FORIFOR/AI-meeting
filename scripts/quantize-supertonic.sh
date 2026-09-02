#!/usr/bin/env bash
# Builds an int8 Supertonic 3 next to the float one. No int8 release exists — not in Supertone's repo,
# the derivatives, or the demo Space — so it is made here.
#
# The vocoder is deliberately left in float: it is the model that turns vectors into a waveform, which
# is where audio quality actually lives, and int8 there is audible as roughness. The other three carry
# almost all of the compute.
#
# Measured on this Mac, F1 at 4 steps, 3.4 s of speech: 1120 ms float → 569 ms int8, 297 MB → 76 MB.
#
# Needs Python with onnx + onnxruntime (a venv is fine):
#   python3 -m venv .venv && .venv/bin/pip install onnx onnxruntime
#   PYTHON=.venv/bin/python scripts/quantize-supertonic.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/vendor/supertonic/onnx"
DST="$ROOT/vendor/supertonic/onnx-int8"
PY="${PYTHON:-python3}"
[ -d "$SRC" ] || { echo "BLOCKED_BY_SUPERTONIC: run scripts/fetch-supertonic.sh first" >&2; exit 1; }
"$PY" -c "import onnxruntime, onnx" 2>/dev/null || { echo "BLOCKED_BY_ONNX_TOOLS: pip install onnx onnxruntime (set PYTHON to that interpreter)" >&2; exit 1; }
mkdir -p "$DST"
cp "$SRC/tts.json" "$SRC/unicode_indexer.json" "$DST/"
"$PY" - "$SRC" "$DST" <<'PYEOF'
import sys, os, shutil
from onnxruntime.quantization import quantize_dynamic, QuantType
src, dst = sys.argv[1], sys.argv[2]
KEEP_FLOAT = {"vocoder"}
for f in sorted(os.listdir(src)):
    if not f.endswith(".onnx"):
        continue
    name, out = f[:-5], os.path.join(dst, f)
    if name in KEEP_FLOAT:
        shutil.copyfile(os.path.join(src, f), out)
        print(f"{name}: kept float")
        continue
    quantize_dynamic(os.path.join(src, f), out, weight_type=QuantType.QInt8)
    print(f"{name}: {os.path.getsize(os.path.join(src, f))/1e6:.0f}MB → {os.path.getsize(out)/1e6:.0f}MB")
PYEOF
echo "int8 models in $DST"
