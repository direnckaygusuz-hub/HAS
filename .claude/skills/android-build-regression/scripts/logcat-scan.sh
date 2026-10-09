#!/usr/bin/env bash
# logcat-scan.sh - capture logcat scoped to the app's UID and scan it (layer 3).
#
# What: a missing drawable still renders (empty), a failed font silently falls
#   back, a string looked up by name fails without failing any assertVisible.
#   Only the logged exception shows it. This captures the app's own log lines
#   (by UID, which stays stable across the restarts a flow suite does, unlike the
#   PID) plus the full log for ANR / process death - which system_server logs
#   about the app, not the app itself - and greps both for those failure modes.
#
# Prerequisites: adb and a connected, authorised device for capture (find-tools.sh
#   finds adb; with several devices set ANDROID_SERIAL). Scan mode needs nothing
#   but bash and grep.
#
# Usage:
#   logcat-scan.sh <appId> <outfile> [--duration S] [--no-clear]
#       capture until Ctrl-C (or for S seconds), then scan. Writes <outfile>
#       (app UID only) and <outfile>.full (whole device, used for ANR only).
#       The log buffer is cleared first unless --no-clear. Run your flows
#       while it captures.
#   logcat-scan.sh --scan <logfile> [--app <appId>] [--full <full-logfile>]
#       scan an existing capture. <logfile>.full is used when present.
#
# Exit: 0 clean, 1 findings, 2 usage or device problem.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# ============================================================================
# NOISE - log lines that are not the app under test. One place; add yours.
# Matched case-insensitively (grep -E) against every hit before reporting.
NOISE=(
  'rampart'                 # Samsung: OS-owned notification channels / Auto Blocker
  'SemGameManager'          # Samsung Game Optimizing Service, runs in-process
  'chucker'                 # debug HTTP inspector in QA builds
  'leakcanary'              # debug leak detector in QA builds
  'StrictMode'              # policy violations: worth a look, not a regression
  'OplusFeatureConfig'      # OPPO / OnePlus framework hooks
  'MiuiFrameworkFactory'    # Xiaomi framework hooks
)
# ============================================================================

# label | pattern | which log ("app" or "full")
CHECKS=(
  'resource not found|Resources\$NotFoundException|Unable to find resource|No package identifier when getting|resource ID #0x[0-9a-f]+|Failed to resolve attribute|app'
  'asset open failure|Failed to open asset|Unable to open asset|FileNotFoundException.*assets/|AssetManager.*(failed|error)|app'
  'font load / fallback|Failed to (load|parse|create) font|Unable to load font|native typeface cannot be made|error loading font|Font .*not found|FontsContract.*(fail|error)|falling back to (the )?(default|system) (font|typeface)|app'
  'drawable / image decode|Cannot load drawable|Invalid drawable tag|Drawable .*not found|Failed to decode|unable to decode stream|ImageDecoder.*(error|fail)|VectorDrawable.*(error|fail)|app'
  'class / method resolution|ClassNotFoundException|NoClassDefFoundError|NoSuchMethodError|NoSuchFieldError|app'
  'FATAL / uncaught exception|FATAL EXCEPTION|AndroidRuntime: Shutting down|E[ /]AndroidRuntime|app'
)

usage() { sed -n '2,/^set -uo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2; }

MODE=capture; APP=""; OUT=""; FULL=""; DURATION=""; CLEAR=1
if [[ "${1:-}" == "--scan" ]]; then
  MODE=scan; OUT="${2:-}"; shift 2 || usage
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --app)  APP="${2:?}"; shift 2 ;;
      --full) FULL="${2:?}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n "$OUT" ]] || usage
else
  [[ $# -ge 2 ]] || usage
  APP="$1"; OUT="$2"; shift 2
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --duration) DURATION="${2:?}"; shift 2 ;;
      --no-clear) CLEAR=0; shift ;;
      *) usage ;;
    esac
  done
fi
[[ -z "$FULL" && -f "$OUT.full" ]] && FULL="$OUT.full"

# ---------------------------------------------------------------- capture ---
if [[ "$MODE" == capture ]]; then
  # shellcheck source=find-tools.sh
  FIND_TOOLS_NEED=adb source "$HERE/find-tools.sh" || exit 2
  state=$(adb get-state 2>&1 | tr -d '\r')
  [[ "$state" == device ]] || { echo "FAIL: device state is '$state' (need exactly one authorised device; see adb devices)" >&2; exit 2; }
  uid=$(adb shell dumpsys package "$APP" 2>/dev/null | grep -m1 -oE '(appId|userId)=[0-9]+' | cut -d= -f2)
  [[ -n "$uid" ]] || { echo "FAIL: $APP is not installed (no appId in dumpsys package)" >&2; exit 2; }

  FULL="$OUT.full"
  [[ "$CLEAR" -eq 1 ]] && adb logcat -c 2>/dev/null
  adb logcat -v threadtime --uid="$uid" > "$OUT"  2>&1 & p_app=$!
  adb logcat -v threadtime              > "$FULL" 2>&1 & p_full=$!
  stop() { kill "$p_app" "$p_full" 2>/dev/null; wait "$p_app" "$p_full" 2>/dev/null; }
  trap 'stop' EXIT
  echo "capturing $APP (uid $uid) -> $OUT  (+ $FULL for ANR)"
  if [[ -n "$DURATION" ]]; then
    sleep "$DURATION"
  else
    echo "run the flows now; Ctrl-C to stop and scan"
    trap 'echo' INT
    wait "$p_app" 2>/dev/null
  fi
  stop; trap - EXIT INT
  if grep -qiE 'unknown option|invalid.*uid' "$OUT"; then
    echo "WARN: this device's logcat has no --uid; scanning the full log instead (more noise)" >&2
    cp "$FULL" "$OUT"
  fi
  echo
fi

# ------------------------------------------------------------------- scan ---
[[ -f "$OUT" ]] || { echo "FAIL: no such log: $OUT" >&2; exit 2; }
noise_re=$(IFS='|'; echo "${NOISE[*]}")

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "=== logcat scan ==="
echo "  app log  : $OUT ($(wc -l < "$OUT" | tr -d ' ') lines${APP:+, $APP})"
[[ -n "$FULL" && -f "$FULL" ]] && echo "  full log : $FULL ($(wc -l < "$FULL" | tr -d ' ') lines, ANR / process death only)"
echo

fail=0; i=0
summary=()
scan() {  # <label> <pattern> <file>
  local label="$1" pat="$2" file="$3" n
  i=$((i + 1))
  grep -aiE "$pat" "$file" 2>/dev/null | grep -aviE "$noise_re" > "$WORK/$i" || true
  n=$(wc -l < "$WORK/$i" | tr -d ' ')
  summary+=("$(printf '  %-30s %5d   %s' "$label" "$n" "$([[ $n -gt 0 ]] && echo FINDING || echo ok)")")
  if [[ "$n" -gt 0 ]]; then
    fail=1
    echo "FINDING: $label ($n lines)"
    # timestamp, pid/tid and level stripped, so one repeated error is one line
    sed -E 's/^[0-9-]+ [0-9:.]+ +([0-9]+ +[0-9]+ +)?[VDIWEF][ /]//' "$WORK/$i" \
      | sort | uniq -c | sort -rn | head -8 \
      | sed 's/^ */    /'
    echo
  fi
}

for c in "${CHECKS[@]}"; do
  label="${c%%|*}"; rest="${c#*|}"; which="${rest##*|}"; pat="${rest%|*}"
  [[ "$which" == app ]] && scan "$label" "$pat" "$OUT"
done

if [[ -n "$FULL" && -f "$FULL" ]]; then
  if [[ -n "$APP" ]]; then
    a="${APP//./\\.}"
    scan "ANR / process death" "ANR in $a|Process $a .*(has died|died)|Force finishing activity $a|am_anr.*$a|am_crash.*$a" "$FULL"
  else
    scan "ANR (any app; pass --app)" "ANR in |am_anr" "$FULL"
  fi
elif grep -qaiE 'ANR in ' "$OUT"; then
  scan "ANR" "ANR in " "$OUT"
fi

echo "--- summary ---"
printf '%s\n' "${summary[@]}"
echo "  (noise excluded: ${NOISE[*]})"
echo
if [[ "$fail" -eq 0 ]]; then
  echo "PASS: no resource, font, drawable, crash or ANR lines${APP:+ for $APP}"
else
  echo "REVIEW: findings above. A finding with every assertion green is exactly what this layer is for."
fi
exit "$fail"
