#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: ./scripts/start-instance.sh [controllerPort] [chromePort]"
  echo "Env: HOST (default 127.0.0.1), USER_DATA_DIR, WAIT_READY_SEC, CHROME_PATH"
  exit 0
fi

CONTROLLER_PORT="${1:-3000}"
CHROME_PORT="${2:-9222}"
HOST="${HOST:-127.0.0.1}"
MODE="${MODE:-normal}"
USER_DATA_DIR="${USER_DATA_DIR:-${HOME:-/tmp}/.lotl/chrome-lotl-${CHROME_PORT}}"
WAIT_READY_SEC="${WAIT_READY_SEC:-180}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$USER_DATA_DIR"

node "$ROOT_DIR/scripts/launch-chrome.js" --chrome-port "$CHROME_PORT" --user-data-dir "$USER_DATA_DIR"

# Start controller in background
nohup node "$ROOT_DIR/scripts/start-controller.js" --host "$HOST" --port "$CONTROLLER_PORT" --chrome-port "$CHROME_PORT" --mode "$MODE" \
  >"$ROOT_DIR/controller_${CONTROLLER_PORT}.out.log" \
  2>"$ROOT_DIR/controller_${CONTROLLER_PORT}.err.log" &

echo "Started controller: http://${HOST}:${CONTROLLER_PORT} (Chrome CDP: ${CHROME_PORT})"
echo "Logs: $ROOT_DIR/controller_${CONTROLLER_PORT}.out.log , $ROOT_DIR/controller_${CONTROLLER_PORT}.err.log"
echo "Waiting for /ready (up to ${WAIT_READY_SEC}s)..."

deadline=$((SECONDS + WAIT_READY_SEC))
while [ $SECONDS -lt $deadline ]; do
  if curl -fsS "http://${HOST}:${CONTROLLER_PORT}/ready" >/dev/null 2>&1; then
    echo "READY ok: http://${HOST}:${CONTROLLER_PORT}/ready"
    exit 0
  fi
  sleep 3
done

echo "WARNING: /ready did not become ok within ${WAIT_READY_SEC}s."
exit 2
