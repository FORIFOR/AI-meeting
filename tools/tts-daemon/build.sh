#!/usr/bin/env bash
# Builds the resident TTS daemon (macOS only; needs Xcode / Command Line Tools with Swift).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/bin"
swiftc -O -framework AVFoundation -framework Foundation -o "$DIR/bin/rcai-tts-daemon" "$DIR/main.swift"
echo "built $DIR/bin/rcai-tts-daemon"
