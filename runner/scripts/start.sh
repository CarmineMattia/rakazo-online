#!/usr/bin/env bash
# Start the Rakijazios local runner in the background (no system service).
# Logs: ~/.config/rakazo-runner/runner.log   PID: ~/.config/rakazo-runner/runner.pid
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONF="${RAKAZO_RUNNER_CONFIG_DIR:-$HOME/.config/rakazo-runner}"
mkdir -p "$CONF" && chmod 700 "$CONF"
if [ -f "$CONF/runner.pid" ] && kill -0 "$(cat "$CONF/runner.pid")" 2>/dev/null; then
  echo "runner already running (pid $(cat "$CONF/runner.pid"))"; exit 0
fi
NODE="${NODE:-node}"
nohup "$NODE" "$DIR/src/index.ts" >>"$CONF/runner.log" 2>&1 &
echo $! >"$CONF/runner.pid"
sleep 1
if kill -0 "$(cat "$CONF/runner.pid")" 2>/dev/null; then
  echo "runner started (pid $(cat "$CONF/runner.pid")), log: $CONF/runner.log"
else
  echo "runner failed to start; see $CONF/runner.log" >&2; exit 1
fi
