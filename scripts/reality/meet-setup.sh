#!/usr/bin/env bash
# Opens the two Cloudflare Quick Tunnels the Recall bot needs, writes their URLs into
# services/token-broker/.env, and prints the command to run the real meeting gate.
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
    WEB_PORT=5173; port_up 5173 || WEB_PORT=5180
    port_up "$WEB_PORT" || { echo "web (5173/5180) が起動していません。'pnpm dev' を実行してください。" >&2; exit 1; }
    echo "→ broker tunnel (localhost:8787)"
    BROKER_URL="$(start_tunnel broker 8787)"
    echo "→ web tunnel (localhost:$WEB_PORT)"
    WEB_URL="$(start_tunnel web "$WEB_PORT")"
    set_env RECALL_PUBLIC_URL "$BROKER_URL"
    set_env RECALL_BOT_PAGE_URL "$WEB_URL"
    echo
    echo "RECALL_PUBLIC_URL   = $BROKER_URL"
    echo "RECALL_BOT_PAGE_URL = $WEB_URL"
    echo "(services/token-broker/.env に書き込みました)"
    echo
    curl -sf --max-time 10 "$BROKER_URL/health" >/dev/null && echo "✓ broker がトンネル経由で応答しました" || echo "! broker にトンネル経由で到達できません"
    curl -sf --max-time 10 -o /dev/null "$WEB_URL/" && echo "✓ web がトンネル経由で応答しました" || echo "! web にトンネル経由で到達できません"
    echo
    echo "次: MEET_URL=\"https://meet.google.com/xxx-xxxx-xxx\" pnpm reality:meet"
    ;;
  stop)
    for n in broker web; do
      [ -f "$RUN_DIR/$n.pid" ] && kill "$(cat "$RUN_DIR/$n.pid")" 2>/dev/null && echo "stopped $n tunnel" || true
      rm -f "$RUN_DIR/$n.pid" "$RUN_DIR/$n.url"
    done
    ;;
  status)
    for n in broker web; do
      if [ -f "$RUN_DIR/$n.url" ] && kill -0 "$(cat "$RUN_DIR/$n.pid" 2>/dev/null)" 2>/dev/null; then
        echo "$n: up — $(cat "$RUN_DIR/$n.url")"
      else
        echo "$n: down"
      fi
    done
    ;;
esac
