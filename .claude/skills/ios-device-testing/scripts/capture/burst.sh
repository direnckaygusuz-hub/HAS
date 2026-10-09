#!/bin/zsh
# burst.sh — save a frame of the iPhone screen at most every N seconds, for T seconds or
# until stopped. Frames only arrive when the screen changes, so a still screen gives one
# file (not a failure) and a tap sequence gives roughly one frame per step with no idle
# duplicates. Use the until-stopped mode when the user drives: a fixed length misses what
# they did after it ran out.
#
# qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
#
# Prerequisites: Grab.app built by build.sh; phone connected, trusted and unlocked.
# Usage:  ./burst.sh <outDir> <everySec> <forSec> [deviceNameSubstring]
#         ./burst.sh --until-stop [--max SEC] <outDir> <everySec> [deviceNameSubstring]
#           (forSec 0 is the same as --until-stop)
#         -> <outDir>/frame-000.png, frame-001.png, …   (old frame-*.png in outDir are removed)
# Stop the until-stopped mode with `touch <outDir>/frame.stop` (path printed on start), or
# Ctrl-C / kill -TERM <burst.sh pid>; it keeps every frame saved so far. --max caps it
# (default 3600 s). Run it in the background and touch the stop file when the user is done.
# Env:    GRAB_APP     path to Grab.app (default <this script's dir>/build/Grab.app)
#         GRAB_LAUNCH  command run instead of `open -W -n -a $GRAB_APP --args` (tests); gets
#                      <prefix> <device> <everySec> <forSec> <maxSec>, writes <prefix>.status
# Prints the status line: "OK burst <n> frames[ (stopped)]" or "ERR …".
set -u
setopt null_glob
SELF=$0
usage() {
    echo "usage: $SELF <outDir> <everySec> <forSec> [deviceNameSubstring]" >&2
    echo "       $SELF --until-stop [--max SEC] <outDir> <everySec> [deviceNameSubstring]" >&2
    exit 64
}
UNTIL=0 MAX=3600
while [[ $# -gt 0 && $1 == --* ]]; do
    case $1 in
        --until-stop) UNTIL=1; shift ;;
        --max) [[ $# -ge 2 ]] || usage; MAX=$2; shift 2 ;;
        --) shift; break ;;
        *) usage ;;
    esac
done
if (( UNTIL )); then
    [[ $# -ge 2 ]] || usage
    DIR=$1 EVERY=$2 FOR=0 DEV=${3:-}
else
    [[ $# -ge 3 ]] || usage
    DIR=$1 EVERY=$2 FOR=$3 DEV=${4:-}
    (( FOR <= 0 )) && UNTIL=1 FOR=0
fi
(( EVERY > 0 )) || { echo "ERR everySec must be > 0" >&2; exit 64; }
APP="${GRAB_APP:-${0:A:h}/build/Grab.app}"
if [[ -z ${GRAB_LAUNCH:-} && ! -d $APP ]]; then
    echo "ERR $APP not found — run build.sh first" >&2; exit 1
fi
DIR="${DIR:A}"
mkdir -p "$DIR"
PREFIX="$DIR/frame"
STOP="$PREFIX.stop"
rm -f "$PREFIX"-<->.png "$PREFIX.status" "$STOP"
if (( UNTIL )); then
    echo "burst: capturing until stopped (max ${MAX}s) — stop with: touch $STOP" >&2
    trap 'touch "$STOP"' INT TERM
fi
if [[ -n ${GRAB_LAUNCH:-} ]]; then
    ${=GRAB_LAUNCH} "$PREFIX" "$DEV" "$EVERY" "$FOR" "$MAX" &
else
    open -W -n -a "$APP" --args "$PREFIX" "$DEV" "$EVERY" "$FOR" "$MAX" &
fi
PID=$!
# `wait` returns early when a trapped signal arrives; keep waiting until Grab has finished.
while kill -0 $PID 2>/dev/null; do wait $PID 2>/dev/null; done
rm -f "$STOP"
cat "$PREFIX.status" 2>/dev/null || { echo "ERR no status"; exit 1; }
echo
grep -q '^OK' "$PREFIX.status"
