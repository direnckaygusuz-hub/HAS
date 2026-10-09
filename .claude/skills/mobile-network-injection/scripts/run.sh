#!/bin/bash
# run.sh — start mitmdump in the background with inject.py and a capture file.
#
# Usage:  ./run.sh [port] [extra mitmdump args...]    e.g. ./run.sh 8080 --listen-host 127.0.0.1
# Env:    MITMDUMP  mitmdump binary (default: on PATH, else ~/.local/bin/mitmdump)
#         CAPTURE   capture file (default <this dir>/capture-<date-time>.mitm)
# Writes mitmdump's output to <this dir>/mitmdump.log. Starts from the current state.json,
# so set the mode you want first (./setstate.sh off for plain recording).
# Stop:   kill $(lsof -ti tcp:<port> -sTCP:LISTEN)    — or ./cleanup-android.sh <port>
# Nothing to edit here per project.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8080}"; shift || true
MITMDUMP="${MITMDUMP:-$(command -v mitmdump || echo "$HOME/.local/bin/mitmdump")}"
CAPTURE="${CAPTURE:-$DIR/capture-$(date +%Y%m%d-%H%M%S).mitm}"
[[ -x "$MITMDUMP" ]] || { echo "mitmdump not found (pipx install mitmproxy, or set MITMDUMP)" >&2; exit 1; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use:" >&2; lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2; exit 1
fi
nohup "$MITMDUMP" --listen-port "$PORT" -s "$DIR/inject.py" -w "$CAPTURE" "$@" \
  > "$DIR/mitmdump.log" 2>&1 &
PID=$!
for _ in $(seq 1 30); do
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  kill -0 "$PID" 2>/dev/null || { echo "mitmdump exited — see $DIR/mitmdump.log:" >&2; tail -20 "$DIR/mitmdump.log" >&2; exit 1; }
  sleep 0.5
done
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || { echo "port $PORT not listening after 15 s — see $DIR/mitmdump.log" >&2; exit 1; }
echo "mitmdump pid $PID listening on :$PORT"
echo "capture: $CAPTURE"
echo "log:     $DIR/mitmdump.log   rewrites: $DIR/inject.log"
echo "stop:    kill \$(lsof -ti tcp:$PORT -sTCP:LISTEN)"
