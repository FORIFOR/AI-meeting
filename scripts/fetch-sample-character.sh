#!/usr/bin/env bash
# Copies Live2D sample models (Live2D Free Material License) from reference/CubismWebSamples
# into character packs. Model files are git-ignored; run this after cloning.
#   yui   <- Hiyori
#   haru  <- Haru
#   reina <- Mao
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/reference/CubismWebSamples/Samples/Resources"
if [ ! -d "$SRC" ]; then
  echo "reference/CubismWebSamples missing; cloning (shallow)…"
  mkdir -p "$ROOT/reference"
  git clone -q --depth 1 https://github.com/Live2D/CubismWebSamples.git "$ROOT/reference/CubismWebSamples"
fi
copy() { # sample charId
  local sample="$1" id="$2" dst="$ROOT/characters/$2/model"
  mkdir -p "$dst"
  find "$dst" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +
  cp -R "$SRC/$sample/." "$dst/"
  cat > "$dst/LICENSE-NOTICE.md" <<NOTICE
# $sample sample model

This directory contains the Live2D sample model "$sample" copied from
https://github.com/Live2D/CubismWebSamples (Samples/Resources/$sample).

It is provided under the **Live2D Free Material License Agreement**
(https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) and the
Live2D sample model terms (https://www.live2d.com/eula/live2d-sample-model-terms_en.html).
Not redistributed by this repository (git-ignored); fetched locally by scripts/fetch-sample-character.sh.
NOTICE
  echo "copied $sample -> characters/$id/model ($(ls "$dst" | wc -l | tr -d ' ') entries)"
}
copy Hiyori yui
copy Haru haru
copy Mao reina

# Kei (Live2D MotionSync sample, ships Kei_basic.motionsync3.json) -> characters/kei
MSSRC="$ROOT/reference/CubismWebMotionSyncComponents/Samples/Resources"
if [ ! -d "$MSSRC" ]; then
  echo "reference/CubismWebMotionSyncComponents missing; cloning (shallow)…"
  git clone -q --depth 1 https://github.com/Live2D/CubismWebMotionSyncComponents.git "$ROOT/reference/CubismWebMotionSyncComponents"
fi
if [ -d "$MSSRC/Kei_basic" ]; then
  dst="$ROOT/characters/kei/model"
  mkdir -p "$dst"; find "$dst" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +
  cp -R "$MSSRC/Kei_basic/." "$dst/"
  cat > "$dst/LICENSE-NOTICE.md" <<NOTICE
# Kei_basic sample model (MotionSync)

Copied from https://github.com/Live2D/CubismWebMotionSyncComponents (Samples/Resources/Kei_basic).
Live2D sample model — Live2D Free Material License Agreement
(https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) and the
Live2D sample model terms. Ships Kei_basic.motionsync3.json (CRI analysis settings); the MotionSync
Core itself is NOT included (BLOCKED_BY_MOTIONSYNC_CORE). Not redistributed by this repository (git-ignored).
NOTICE
  echo "copied Kei_basic -> characters/kei/model ($(ls "$dst" | wc -l | tr -d ' ') entries)"
fi
