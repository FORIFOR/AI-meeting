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
# llama-server picks -np automatically (4 slots) and shares one unified KV of LLM_CTX tokens across them.
# The agent's prompt runs to ~3000 tokens (persona + notes + a window at 1.5 budgets) and a fold or a
# re-warm runs beside the conversation, so 4096 evicted the conversation slot to the host cache on every
# fold and the next turn re-read the whole prompt (Gate #8 run 92: 3100 tokens, first token 4.6 s).
LLM_CTX="${LOCAL_LLM_CTX:-16384}"
WHISPER_MODEL="${WHISPER_MODEL:-$MODELS_DIR/whisper-eval/ggml-kotoba-whisper-v2.0.bin}"
WHISPER_PORT="${WHISPER_PORT:-8178}"
LOCAL_STT="${LOCAL_STT:-sherpa}"
RUN_DIR="${RCAI_RUN_DIR:-${TMPDIR:-/tmp}/rcai-local-stack}"
mkdir -p "$RUN_DIR"

start_llama() {
  if curl -sf "http://127.0.0.1:$LLM_PORT/v1/models" >/dev/null 2>&1; then echo "llama-server already up on :$LLM_PORT"; return; fi
  [ -f "$LLM_GGUF" ] || { echo "BLOCKED_BY_LOCAL_LLM_MODEL: $LLM_GGUF not found" >&2; exit 1; }
  command -v llama-server >/dev/null || { echo "BLOCKED_BY_LLAMA_CPP: llama-server not installed (brew install llama.cpp)" >&2; exit 1; }
  # --no-clear-idle: by default a new task on one slot saves every *idle* slot's prompt to the host cache
  # and clears its KV ("save and clear idle slots on new task"). The agent's fold runs while the
  # conversation slot is idle, so every fold evicted the conversation; the turn after a barge-in then
  # failed to load it back (its prefix diverges where the reply was cut) and re-read 3300 tokens in
  # 5 s (Gate #8 runs 92 and 94). With 16384 tokens of unified KV the slots fit side by side.
  nohup llama-server -m "$LLM_GGUF" --host 127.0.0.1 --port "$LLM_PORT" -c "$LLM_CTX" -ngl 99 --jinja -fa on --reasoning off --no-clear-idle \
    > "$RUN_DIR/llama-server.log" 2>&1 &
  echo $! > "$RUN_DIR/llama-server.pid"
  echo "llama-server starting (pid $(cat "$RUN_DIR/llama-server.pid"), log $RUN_DIR/llama-server.log)"
  for _ in $(seq 1 120); do
    if curl -sf "http://127.0.0.1:$LLM_PORT/v1/models" >/dev/null 2>&1; then echo "llama-server ready: $(basename "$LLM_GGUF")"; return; fi
    sleep 1
  done
  echo "llama-server did not become ready" >&2; exit 1
}

# The first requests after a start are slow — Metal pipelines compile on first use per batch shape
# (run 92: 27 tokens in 7.8 s, a 1101-token prompt in 9.0 s; the same prompt read in 2.5 s afterwards,
# and the greeting waited 7.9 s behind it). Two throwaway completions, short and long, take that hit here.
warm_llama() {
  local short long
  short='{"model":"m","max_tokens":1,"messages":[{"role":"user","content":"はい。"}]}'
  long=$(python3 -c 'import json; print(json.dumps({"model":"m","max_tokens":1,"messages":[{"role":"system","content":"あなたは会議に参加しているキャラクターです。" * 60},{"role":"user","content":"こんにちは。"}]}, ensure_ascii=False))')
  local t0 t1; t0=$(date +%s)
  curl -sf -o /dev/null --max-time 120 -H 'content-type: application/json' -d "$short" "http://127.0.0.1:$LLM_PORT/v1/chat/completions" || true
  curl -sf -o /dev/null --max-time 120 -H 'content-type: application/json' -d "$long" "http://127.0.0.1:$LLM_PORT/v1/chat/completions" || true
  t1=$(date +%s)
  echo "llama-server warmed (short + ~1000-token prompt) in $((t1 - t0)) s"
}

start_whisper() {
  if curl -sf "http://127.0.0.1:$WHISPER_PORT/" >/dev/null 2>&1; then echo "whisper-server already up on :$WHISPER_PORT"; return; fi
  [ -f "$WHISPER_MODEL" ] || { echo "BLOCKED_BY_WHISPER_MODEL: $WHISPER_MODEL not found" >&2; exit 1; }
  command -v whisper-server >/dev/null || { echo "BLOCKED_BY_WHISPER_CPP: whisper-server not installed (brew install whisper-cpp)" >&2; exit 1; }
  # -nc: one decoder state serves every request; without it each utterance is decoded with the previous
  # one's text as its prompt (the agent also sends no_context=true per request — belt and braces).
  nohup whisper-server -m "$WHISPER_MODEL" --host 127.0.0.1 --port "$WHISPER_PORT" -l ja -nt -nc \
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
    warm_llama
    if [ "$LOCAL_STT" = "whisper" ]; then start_whisper; fi
    echo "agent: cd services/agent && LOCAL_TTS=supertonic LOCAL_STT_FINAL=whisper-async LOCAL_TTS_READINGS=\"Yui=ゆい\" pnpm -s exec tsx src/server.ts   (LOCAL_LLM_URL=http://127.0.0.1:$LLM_PORT/v1; 'pnpm dev' is tsx watch and reloads the agent on every edit — not for a room run)"
    ;;
  stop)
    stop_one llama-server; stop_one whisper-server ;;
  status)
    curl -sf "http://127.0.0.1:$LLM_PORT/v1/models" >/dev/null && echo "llama-server: up" || echo "llama-server: down"
    curl -sf "http://127.0.0.1:$WHISPER_PORT/" >/dev/null && echo "whisper-server: up" || echo "whisper-server: down"
    curl -sf "http://127.0.0.1:8788/health" || echo "agent: down" ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
