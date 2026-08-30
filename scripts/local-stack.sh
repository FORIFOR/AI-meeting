#!/usr/bin/env bash
# Starts / stops the fully-local AI stack used by services/agent (spec §6).
#   scripts/local-stack.sh start   # llama-server (+ whisper-server when LOCAL_STT=whisper)
#   scripts/local-stack.sh stop
#   scripts/local-stack.sh status
# Everything binds to 127.0.0.1 only. Override paths with env vars.
set -euo pipefail

MODELS_DIR="${DEEPNOTE_MODELS_DIR:-$HOME/Library/Application Support/DeepNote/models}"
LLM_GGUF="${LOCAL_LLM_GGUF:-$MODELS_DIR/gemma-4-E2B-it-Q4_K_M.gguf}"
LLM_PORT="${LOCAL_LLM_PORT:-8080}"
LLM_CTX="${LOCAL_LLM_CTX:-4096}"
WHISPER_MODEL="${WHISPER_MODEL:-$MODELS_DIR/whisper-eval/ggml-kotoba-whisper-v2.0.bin}"
WHISPER_PORT="${WHISPER_PORT:-8178}"
LOCAL_STT="${LOCAL_STT:-sherpa}"
RUN_DIR="${RCAI_RUN_DIR:-${TMPDIR:-/tmp}/rcai-local-stack}"
mkdir -p "$RUN_DIR"

start_llama() {
  if curl -sf "http://127.0.0.1:$LLM_PORT/v1/models" >/dev/null 2>&1; then echo "llama-server already up on :$LLM_PORT"; return; fi
  [ -f "$LLM_GGUF" ] || { echo "BLOCKED_BY_LOCAL_LLM_MODEL: $LLM_GGUF not found" >&2; exit 1; }
  command -v llama-server >/dev/null || { echo "BLOCKED_BY_LLAMA_CPP: llama-server not installed (brew install llama.cpp)" >&2; exit 1; }
  nohup llama-server -m "$LLM_GGUF" --host 127.0.0.1 --port "$LLM_PORT" -c "$LLM_CTX" -ngl 99 --jinja -fa on --reasoning off \
    > "$RUN_DIR/llama-server.log" 2>&1 &
  echo $! > "$RUN_DIR/llama-server.pid"
  echo "llama-server starting (pid $(cat "$RUN_DIR/llama-server.pid"), log $RUN_DIR/llama-server.log)"
  for _ in $(seq 1 120); do
    if curl -sf "http://127.0.0.1:$LLM_PORT/v1/models" >/dev/null 2>&1; then echo "llama-server ready: $(basename "$LLM_GGUF")"; return; fi
    sleep 1
  done
  echo "llama-server did not become ready" >&2; exit 1
}

start_whisper() {
  if curl -sf "http://127.0.0.1:$WHISPER_PORT/" >/dev/null 2>&1; then echo "whisper-server already up on :$WHISPER_PORT"; return; fi
  [ -f "$WHISPER_MODEL" ] || { echo "BLOCKED_BY_WHISPER_MODEL: $WHISPER_MODEL not found" >&2; exit 1; }
  command -v whisper-server >/dev/null || { echo "BLOCKED_BY_WHISPER_CPP: whisper-server not installed (brew install whisper-cpp)" >&2; exit 1; }
  nohup whisper-server -m "$WHISPER_MODEL" --host 127.0.0.1 --port "$WHISPER_PORT" -l ja -nt \
    > "$RUN_DIR/whisper-server.log" 2>&1 &
  echo $! > "$RUN_DIR/whisper-server.pid"
  echo "whisper-server starting (pid $(cat "$RUN_DIR/whisper-server.pid"))"
}

stop_one() {
  local f="$RUN_DIR/$1.pid"
  if [ -f "$f" ]; then kill "$(cat "$f")" 2>/dev/null && echo "stopped $1" || true; rm -f "$f"; fi
}

build_tts_daemon() {
  local root; root="$(cd "$(dirname "$0")/.." && pwd)"
  if [ -x "$root/tools/tts-daemon/bin/rcai-tts-daemon" ]; then echo "tts daemon: built"; return; fi
  if command -v swiftc >/dev/null 2>&1; then "$root/tools/tts-daemon/build.sh" || echo "tts daemon build failed — agent falls back to say" >&2
  else echo "swiftc not found — agent falls back to macOS say (≈0.7 s TTFA)" >&2; fi
}

case "${1:-start}" in
  start)
    build_tts_daemon
    start_llama
    if [ "$LOCAL_STT" = "whisper" ]; then start_whisper; fi
    echo "agent: pnpm --filter @rcai/agent dev   (LOCAL_LLM_URL=http://127.0.0.1:$LLM_PORT/v1)"
    ;;
  stop)
    stop_one llama-server; stop_one whisper-server ;;
  status)
    curl -sf "http://127.0.0.1:$LLM_PORT/v1/models" >/dev/null && echo "llama-server: up" || echo "llama-server: down"
    curl -sf "http://127.0.0.1:$WHISPER_PORT/" >/dev/null && echo "whisper-server: up" || echo "whisper-server: down"
    curl -sf "http://127.0.0.1:8788/health" || echo "agent: down" ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
