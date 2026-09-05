#!/usr/bin/env bash
# Opens the three Cloudflare Quick Tunnels the Recall bot needs (broker, bot page, agent), writes
# their URLs into services/token-broker/.env, and prints the command to run the real meeting gate.
# Run 91: the agent's tunnel had been opened by hand and died with a reboot; this script re-opened the
# other two, every pre-flight passed, and the character sat deaf and mute for four passes.
#
#   scripts/reality/meet-setup.sh start   # start tunnels + record URLs
#   scripts/reality/meet-setup.sh stop    # close them (URLs die with the process)
#   scripts/reality/meet-setup.sh status
#
# The tunnels expose the local broker and web app to the public internet for as long as they run.
# Close them when the test is over.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/services/token-broker/.env"
RUN_DIR="${TMPDIR:-/tmp}/rcai-meet-tunnels"
mkdir -p "$RUN_DIR"

port_up() { curl -sf -o /dev/null --max-time 2 "http://localhost:$1/" 2>/dev/null || curl -sf -o /dev/null --max-time 2 "http://localhost:$1/health" 2>/dev/null; }

set_env() { # key value — rewrite the line in .env
  local k="$1" v="$2"
  touch "$ENV_FILE"
  if grep -q "^${k}=" "$ENV_FILE"; then
    /usr/bin/sed -i '' "s#^${k}=.*#${k}=${v}#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}

start_tunnel() { # name port -> writes $RUN_DIR/name.url
  local name="$1" port="$2"
  local log="$RUN_DIR/$name.log"
  : > "$log"
  nohup cloudflared tunnel --url "http://localhost:$port" --no-autoupdate > "$log" 2>&1 &
  echo $! > "$RUN_DIR/$name.pid"
  for _ in $(seq 1 40); do
    local url
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
    if [ -n "$url" ]; then echo "$url" > "$RUN_DIR/$name.url"; echo "$url"; return 0; fi
    sleep 1
  done
  echo "FAIL: $name tunnel did not report a URL (see $log)" >&2
  return 1
}

case "${1:-start}" in
  start)
    command -v cloudflared >/dev/null || { echo "cloudflared がありません: brew install cloudflared" >&2; exit 1; }
    port_up 8787 || { echo "broker (8787) が起動していません。別ターミナルで 'pnpm dev' を実行してください。" >&2; exit 1; }
    # The bot page should be the built app (`pnpm --filter @rcai/web build && pnpm --filter @rcai/web preview`, 5180):
    # the dev server's HMR client reloads the page when its socket drops and comes back (a tunnel hiccup), and a
    # reloaded bot page cannot re-activate its single-use token — run 88 lost the character mid-meeting that way.
    if [ -z "${WEB_PORT:-}" ]; then
      if port_up 5180; then WEB_PORT=5180; elif port_up 5173; then WEB_PORT=5173; else WEB_PORT=""; fi
    fi
    [ -n "$WEB_PORT" ] && port_up "$WEB_PORT" || { echo "web (5180 preview / 5173 dev) が起動していません。'pnpm --filter @rcai/web build && pnpm --filter @rcai/web preview' を実行してください。" >&2; exit 1; }
    [ "$WEB_PORT" = 5173 ] && echo "! 5173 は Vite dev server です: HMR クライアントがトンネル断のあと bot ページを reload します (run 88)。本番相当は 5180 (vite preview)。" >&2
    echo "→ broker tunnel (localhost:8787)"
    BROKER_URL="$(start_tunnel broker 8787)"
    echo "→ web tunnel (localhost:$WEB_PORT)"
    WEB_URL="$(start_tunnel web "$WEB_PORT")"
    AGENT_PORT="${AGENT_PORT:-8788}"
    port_up "$AGENT_PORT" || echo "! agent ($AGENT_PORT) が起動していません — トンネルは開きますが、ノック前に起動してください" >&2
    echo "→ agent tunnel (localhost:$AGENT_PORT)"
    AGENT_URL="$(start_tunnel agent "$AGENT_PORT")"
    set_env RECALL_PUBLIC_URL "$BROKER_URL"
    set_env RECALL_BOT_PAGE_URL "$WEB_URL"
    set_env RECALL_AGENT_PUBLIC_URL "$AGENT_URL"
    echo
    echo "RECALL_PUBLIC_URL       = $BROKER_URL"
    echo "RECALL_BOT_PAGE_URL     = $WEB_URL"
    echo "RECALL_AGENT_PUBLIC_URL = $AGENT_URL"
    echo "(services/token-broker/.env に書き込みました — broker は起動時に読むので再起動してください)"
    echo
    # A fresh quick-tunnel hostname can take a minute to resolve, and a resolver that answered NXDOMAIN
    # once caches it (the web tunnel of run 91 never came back on this host; a new tunnel did). Wait.
    sleep 20
    check() { local n="$1" u="$2"; local i; for i in 1 2 3 4 5 6; do curl -sf --max-time 10 -o /dev/null "$u" && { echo "✓ $n がトンネル経由で応答しました"; return 0; }; sleep 10; done; echo "! $n にトンネル経由で到達できません ($u) — トンネルを作り直してください (stop → start)"; return 1; }
    check broker "$BROKER_URL/health"
    check web "$WEB_URL/"
    check agent "$AGENT_URL/health"
    echo
    echo "次: MEET_URL=\"https://meet.google.com/xxx-xxxx-xxx\" pnpm reality:meet"
    ;;
  stop)
    for n in broker web agent; do
      [ -f "$RUN_DIR/$n.pid" ] && kill "$(cat "$RUN_DIR/$n.pid")" 2>/dev/null && echo "stopped $n tunnel" || true
      rm -f "$RUN_DIR/$n.pid" "$RUN_DIR/$n.url"
    done
    ;;
  status)
    for n in broker web agent; do
      if [ -f "$RUN_DIR/$n.url" ] && kill -0 "$(cat "$RUN_DIR/$n.pid" 2>/dev/null)" 2>/dev/null; then
        echo "$n: up — $(cat "$RUN_DIR/$n.url")"
      else
        echo "$n: down"
      fi
    done
    ;;
esac
