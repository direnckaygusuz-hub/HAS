#!/bin/bash
# cleanup-android.sh — undo the Android proxy setup and stop mitmdump. Run it every time,
# before handing the phone back: a global proxy pointing at a dead proxy cuts all internet.
#
# Usage:  ./cleanup-android.sh [port]      (default 8080)
# Env:    ANDROID_SERIAL  pick one device when several are connected (standard adb variable)
# Does:   adb shell settings put global http_proxy :0
#         adb reverse --remove tcp:<port>
#         kill whatever listens on <port>
# Without adb or without a device it skips the phone steps and still stops the listener.
# iOS has no equivalent: the user sets Wi-Fi → proxy back to Off on the phone.
# Nothing to edit here per project.
set -uo pipefail
PORT="${1:-8080}"
if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found — skipped phone proxy reset and adb reverse (do them by hand if a phone was set up)"
elif [[ "$(adb get-state 2>/dev/null)" != "device" ]]; then
  echo "no (single) adb device ready — skipped phone steps; run again with the phone connected"
else
  adb shell settings put global http_proxy :0 && echo "phone: global http_proxy reset to :0"
  echo "phone: http_proxy is now '$(adb shell settings get global http_proxy | tr -d '\r')'"
  adb reverse --remove "tcp:$PORT" 2>/dev/null && echo "phone: adb reverse tcp:$PORT removed" \
    || echo "phone: no adb reverse for tcp:$PORT (already gone)"
fi
PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$PIDS" ]]; then
  kill $PIDS
  for _ in $(seq 1 20); do lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done
  if lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "listener on :$PORT still running after kill — check: lsof -nP -iTCP:$PORT -sTCP:LISTEN" >&2; exit 1
  fi
  echo "stopped listener on :$PORT (pid" $PIDS")"
else
  echo "nothing listening on :$PORT"
fi
