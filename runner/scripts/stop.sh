#!/usr/bin/env bash
# Stop the background Rakijazios local runner.
set -euo pipefail
CONF="${RAKAZO_RUNNER_CONFIG_DIR:-$HOME/.config/rakazo-runner}"
if [ ! -f "$CONF/runner.pid" ]; then echo "runner not running (no pid file)"; exit 0; fi
PID="$(cat "$CONF/runner.pid")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
  echo "runner stopped (pid $PID)"
else
  echo "runner not running (stale pid $PID)"
fi
rm -f "$CONF/runner.pid"
