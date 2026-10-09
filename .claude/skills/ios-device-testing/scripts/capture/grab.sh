#!/bin/zsh
# grab.sh — save one frame of the USB-connected iPhone screen as PNG.
#
# qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
#
# Prerequisites: Grab.app built by build.sh; phone connected, trusted and unlocked.
# First run shows a camera permission prompt the user must approve.
# Usage:  ./grab.sh <out.png> [deviceNameSubstring]
# Env:    GRAB_APP   path to Grab.app (default <this script's dir>/build/Grab.app)
# Prints the tool's status line: "OK <w>x<h>" or "ERR …".
set -u
[[ $# -ge 1 ]] || { echo "usage: $0 <out.png> [deviceNameSubstring]" >&2; exit 64; }
APP="${GRAB_APP:-${0:A:h}/build/Grab.app}"
[[ -d "$APP" ]] || { echo "ERR $APP not found — run build.sh first" >&2; exit 1; }
OUT="${1:A}"
mkdir -p "${OUT:h}"
rm -f "$OUT" "$OUT.status"
# -W waits for exit, -n forces a fresh instance; `open` is what gets the app its camera grant.
open -W -n -a "$APP" --args "$OUT" "${2:-}"
cat "$OUT.status" 2>/dev/null || { echo "ERR no status"; exit 1; }
grep -q '^OK' "$OUT.status"
