#!/usr/bin/env bash
# Self-hosted Attendee (Elastic License 2.0) for `pnpm reality:attendee:auto`, at no vendor cost.
#
#   scripts/reality/attendee-selfhost/attendee-selfhost.sh patch    # apply local-patches.diff to the checkout (once, before build)
#   scripts/reality/attendee-selfhost/attendee-selfhost.sh build    # image (linux/amd64, emulated on Apple silicon)
#   scripts/reality/attendee-selfhost/attendee-selfhost.sh build-arm64  # native image (Dockerfile.arm64, Debian Chromium); use it with RCAI_ATTENDEE_IMAGE=attendee-attendee-app-local:arm64 up
#   scripts/reality/attendee-selfhost/attendee-selfhost.sh env      # write $ATTENDEE_DIR/.env (keys, MinIO)
#   scripts/reality/attendee-selfhost/attendee-selfhost.sh up       # postgres, redis, minio, app, worker, scheduler, streamer
#   scripts/reality/attendee-selfhost/attendee-selfhost.sh migrate
#   scripts/reality/attendee-selfhost/attendee-selfhost.sh logs [service]
#   scripts/reality/attendee-selfhost/attendee-selfhost.sh restart  # after editing .env
#   scripts/reality/attendee-selfhost/attendee-selfhost.sh down
#
# Then: sign up at http://localhost:8000 (the confirmation link is printed in the app log), create an
# API key in the UI, and put ATTENDEE_API_BASE_URL=http://localhost:8000 + ATTENDEE_API_KEY=… in
# services/token-broker/.env. The gate script and the broker read both.
#
# local-patches.diff (against attendee c8f7761) is what the measured runs used — five changes that are
# not upstream: RCAI_DISABLE_DEBUG_RECORDING (no second x264 encoder per bot), RCAI_EXTRA_CHROME_ARGS and
# RCAI_DEBUG_JOIN_SCREENSHOTS (diagnostics), back-to-back scheduling of queued output audio in
# shared_chromedriver_payload.js so a starved main thread does not open gaps mid-sentence (Gate #8 runs
# 17–28), and the Meet payload's WebSocket opened one macrotask after document start — opened inline,
# Chromium 151 (the arm64 image) drops the meet.google.com navigation; and restart_bot_pod relaunching the bot
# in place when LAUNCH_BOT_METHOD is not kubernetes (Meet's repeated no-<audio> variant otherwise ends the bot
# with a kube-config error). compose.rcai.yaml sets the env vars. Docker Desktop needs ~12 GB free for the image plus the bot containers' per-run scratch;
# at 2 GB free the stack stopped mid-run (run 26).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ATTENDEE_DIR="${ATTENDEE_DIR:-$HOME/Projects/attendee}"
[ -f "$ATTENDEE_DIR/dev.docker-compose.yaml" ] || { echo "BLOCKED_BY_ATTENDEE_CHECKOUT: clone https://github.com/attendee-labs/attendee to $ATTENDEE_DIR (or set ATTENDEE_DIR)"; exit 2; }
compose() { docker compose --project-directory "$ATTENDEE_DIR" -f "$ATTENDEE_DIR/dev.docker-compose.yaml" -f "$HERE/compose.rcai.yaml" --profile webpage-streamer "$@"; }
lan_ip() { ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1; }

case "${1:-}" in
  patch)
    if git -C "$ATTENDEE_DIR" apply --check -R "$HERE/local-patches.diff" 2>/dev/null; then echo "local-patches.diff already applied"; exit 0; fi
    git -C "$ATTENDEE_DIR" apply "$HERE/local-patches.diff" && echo "applied local-patches.diff to $ATTENDEE_DIR (rebuild the image)" ;;
  build)   compose build attendee-app-local ;;
  build-arm64) docker build --platform linux/arm64 -f "$HERE/Dockerfile.arm64" -t attendee-attendee-app-local:arm64 "$ATTENDEE_DIR" ;;
  env)
    ENV="$ATTENDEE_DIR/.env"
    if [ -f "$ENV" ]; then echo "$ENV exists — not overwriting"; exit 0; fi
    KEYS="$(compose run --rm --no-deps attendee-app-local python init_env.py)"
    IP="$(lan_ip)"
    {
      echo "$KEYS" | grep -E '^(CREDENTIALS_ENCRYPTION_KEY|DJANGO_SECRET_KEY)='
      echo "AWS_RECORDING_STORAGE_BUCKET_NAME=attendee-recordings"
      echo "AWS_ACCESS_KEY_ID=attendee"
      echo "AWS_SECRET_ACCESS_KEY=attendee-local-only"
      echo "AWS_DEFAULT_REGION=us-east-1"
      echo "AWS_ENDPOINT_URL=http://$IP:9000"
      echo "MINIO_ROOT_USER=attendee"
      echo "MINIO_ROOT_PASSWORD=attendee-local-only"
      echo "ENABLE_VOICE_AGENTS=true"
    } > "$ENV"
    echo "wrote $ENV (MinIO at http://$IP:9000)"
    ;;
  up)      compose up -d ;;
  migrate) compose exec attendee-app-local python manage.py migrate ;;
  logs)    compose logs -f --tail=200 "${2:-attendee-app-local}" ;;
  restart) compose restart attendee-app-local attendee-worker-local attendee-scheduler-local ;;
  down)    compose down ;;
  ps)      compose ps ;;
  *)       sed -n 2,16p "$0"; exit 1 ;;
esac
