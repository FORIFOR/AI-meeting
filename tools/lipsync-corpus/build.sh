#!/usr/bin/env bash
# Synthesises the lip-sync corpus WAVs with macOS `say` (Kyoko, 48 kHz mono 16-bit) into wav/ (git-ignored).
#   normal: as written · fast: -r 260 (早口) · quiet: −20 dB (小声, made with python from the normal take)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/wav"; mkdir -p "$OUT"
VOICE="${LIPSYNC_VOICE:-Kyoko}"
python3 - "$DIR/corpus.json" "$OUT" "$VOICE" <<'PY'
import json, subprocess, sys, wave, struct, os
corpus, out, voice = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(corpus))
n = 0
for s in d["sentences"]:
    base = os.path.join(out, f'{s["id"]}.wav')
    subprocess.run(["say", "-v", voice, "--data-format=LEI16@48000", "-o", base, s["text"]], check=True)
    subprocess.run(["say", "-v", voice, "-r", "260", "--data-format=LEI16@48000", "-o", os.path.join(out, f'{s["id"]}__fast.wav'), s["text"]], check=True)
    w = wave.open(base, "rb"); frames = w.readframes(w.getnframes()); params = w.getparams(); w.close()
    samples = struct.unpack(f"<{len(frames)//2}h", frames)
    g = 10 ** (-20 / 20)
    quiet = struct.pack(f"<{len(samples)}h", *[int(max(-32768, min(32767, v * g))) for v in samples])
    q = wave.open(os.path.join(out, f'{s["id"]}__quiet.wav'), "wb"); q.setparams(params); q.writeframes(quiet); q.close()
    n += 3
print(f"{n} wav files in {out}")
PY
