#!/usr/bin/env bash
# Restart the Genspark shell from source: stop any instance started from this
# project, then launch a fresh one detached so the terminal stays free.
set -euo pipefail

cd "$(dirname "$0")"

LOG="${TMPDIR:-/tmp}/genspark-shell.log"

# Scoped to this project's path so unrelated Electron apps are left alone.
pkill -f "genspark/node_modules/electron" 2>/dev/null || true
pkill -f "genspark/node_modules/.bin/electron" 2>/dev/null || true
sleep 1

nohup npm start >"$LOG" 2>&1 &
echo "Genspark restarted (PID $!)."
echo "Logs: $LOG"
