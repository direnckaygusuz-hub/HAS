#!/bin/bash
# up.sh — start (or reuse) Maestro's XCUITest driver runner on a USB-connected iPhone plus
# the usbmux forwarder, wait until /status answers, and say why when it doesn't.
# Idempotent: run it whenever the driver may have dropped (VoiceOver toggle, rotation,
# phone locked) instead of restarting xcodebuild + usbfwd.py by hand.
#
# qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
#
# Prerequisites: macOS, Xcode, python3; the driver built and signed for this phone
#   (references/setup.md#xcuitest-driver); phone on USB, unlocked, online, not behind a proxy.
# Usage:
#   up.sh [start] [--udid UDID] [--port PORT] [--timeout SEC]   start or reuse (default)
#   up.sh status  [--port PORT]     what runs, who holds the port, does /status answer
#   up.sh down    [--port PORT]     stop the runner + forwarder this script started
#   up.sh diagnose <runner.log> [forwarder.log]   map a log to a likely cause + fix
# Env:
#   DRIVER_BUILD     driver build dir (searched for *.xctestrun) or the .xctestrun itself;
#                    default ~/.maestro/maestro-iphoneos-driver-build
#   IOS_DRIVER_PORT  port on the phone and on the Mac (default 22087)
#   IOS_UDID         default UDID (otherwise: the single USB-connected device)
#   UP_TIMEOUT       seconds to wait for /status (default 120)
#   UP_STATE_DIR     pidfile + logs (default <this dir>/.up — add it to .gitignore)
#   XCODEBUILD, USBFWD   command overrides (tests); default xcodebuild / python3 usbfwd.py
# Runs: TEST_RUNNER_PORT=<port> xcodebuild test-without-building -xctestrun <file>
#       -destination id=<udid>   and   usbfwd.py --udid <udid> <port>   in the background.
# Only processes recorded in the pidfile are ever killed; other port owners are reported.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${IOS_DRIVER_PORT:-22087}"
UDID="${IOS_UDID:-}"
TIMEOUT="${UP_TIMEOUT:-120}"
STATE="${UP_STATE_DIR:-$HERE/.up}"

say() { printf 'up: %s\n' "$*"; }
die() { printf 'up: %s\n' "$*" >&2; exit "${2:-1}"; }

# ---------------------------------------------------------------- log -> cause
# Each rule: "<ERE pattern, may contain |>|<cause>|<fix>" — cause and fix contain no "|".
# Patterns are case-insensitive; the first rule that matches is the likely cause.
RULES=(
"device is locked|Unlock .+ to Continue|passcode[- ]locked|The phone is locked.|Unlock it, set Auto-Lock to Never, then run up.sh again."
"enabling automation mode|Enable UI Automation|UI Automation.*(disabled|not enabled)|UI automation is not enabled.|On the phone: Settings > Developer > Enable UI Automation, then up.sh again."
"Developer App Certificate is not trusted|requires preflight|denied by service delegate|Untrusted Developer|not been explicitly trusted|could not be verified|iOS could not verify the runner's developer certificate: the phone is offline or behind a proxy that intercepts Apple's hosts, or the developer is not trusted yet.|Put the phone online without the proxy (or pass Apple's hosts through it), trust the developer in Settings > General > VPN & Device Management, then up.sh again. Start the runner before going offline."
"provisioning profile.*(does not|doesn.t) include|not included in .*provisioning profile|isn.t registered|has no devices|profile has expired|provisioning profile.*expired|No profiles for|0xe8008012|The provisioning profile does not include this phone, or it expired (personal-team profiles last 7 days).|Rebuild the driver for this phone with -destination id=<udid> -allowProvisioningDeviceRegistration (references/setup.md#xcuitest-driver)."
"Developer Mode (is )?(disabled|off|not enabled)|enable Developer Mode|Developer Mode is off.|On the phone: Settings > Privacy & Security > Developer Mode, restart, confirm."
"Unable to find a destination matching|Unable to find a device matching|unpaired|Xcode does not see a phone with this UDID.|Check the cable and the trust prompt, compare with xcrun devicectl list devices, pass --udid."
"no USB device found|not found on USB|The phone is not on USB (Wi-Fi only): usbmux cannot forward to it.|Connect the cable, unlock, accept the trust prompt; usbfwd.py --list shows what usbmux sees."
"usbmux connect to device port [0-9]+ refused|The forwarder works, but nothing listens on that port on the phone yet (runner not started, or started with another TEST_RUNNER_PORT).|Wait for 'starting server' in the runner log; if it never comes, read the runner log above it. Port on the phone and on the Mac must match."
"Address already in use|The local port is held by another process.|up.sh status shows the owner; stop it if it is stale, or use --port."
"connection was invalidated|Lost connection to|Test runner exited|unexpected exit|crashed|Mercury\.error|The runner started and then dropped (VoiceOver toggled, rotation, the phone slept, or another runner took the phone).|Run up.sh again. One runner per phone: pgrep -fl test-without-building."
)

diagnose() {  # diagnose <runner.log> [fwd.log] — prints the cause; exit 0 if a rule matched
    local logs=() f found=0 rule pat cause fix line
    for f in "$@"; do [ -f "$f" ] && logs+=("$f"); done
    [ ${#logs[@]} -gt 0 ] || { echo "no log to read"; return 1; }
    for rule in "${RULES[@]}"; do
        fix="${rule##*|}"; rule="${rule%|*}"
        cause="${rule##*|}"; pat="${rule%|*}"
        line="$(grep -h -i -E -m1 -- "$pat" "${logs[@]}" 2>/dev/null | head -1)"
        [ -n "$line" ] || continue
        if [ $found -eq 0 ]; then
            echo "Likely cause: $cause"
            echo "Fix:          ${fix//<udid>/${UDID:-<udid>}}"
            echo "Log line:     $(printf '%s' "$line" | sed 's/^[[:space:]]*//' | cut -c1-200)"
        else
            echo "Also seen:    $cause"
        fi
        found=$((found + 1))
    done
    if [ $found -eq 0 ]; then
        echo "No known cause in the log. Last lines of ${logs[0]}:"
        tail -n 15 "${logs[0]}" | sed 's/^/  /'
        return 1
    fi
    return 0
}

# ---------------------------------------------------------------- helpers
PIDFILE() { echo "$STATE/$PORT.pids"; }
RLOG() { echo "$STATE/runner-$PORT.log"; }
FLOG() { echo "$STATE/forwarder-$PORT.log"; }

status_ok() { curl -s -m 3 "http://127.0.0.1:$PORT/status" 2>/dev/null | grep -q '"ok"'; }

recorded() {  # recorded <role> -> pid from the pidfile, if any
    [ -f "$(PIDFILE)" ] && awk -v r="$1" '$1 == r { print $2 }' "$(PIDFILE)" | tail -1
}

is_ours_alive() {  # is_ours_alive <role> — recorded pid alive and still the same kind of process
    local pid sig cmd
    pid="$(recorded "$1")"; [ -n "$pid" ] || return 1
    case "$1" in runner) sig="test-without-building" ;; fwd) sig="usbfwd" ;; *) return 1 ;; esac
    cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
    [[ "$cmd" == *"$sig"* ]]
}

port_owners() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u; }

stop_ours() {
    local role pid i
    for role in fwd runner; do
        is_ours_alive "$role" || continue
        pid="$(recorded "$role")"
        kill -TERM "$pid" 2>/dev/null
        for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
        kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
        say "stopped $role (pid $pid)"
    done
    rm -f "$(PIDFILE)"
}

find_xctestrun() {
    local b="${DRIVER_BUILD:-$HOME/.maestro/maestro-iphoneos-driver-build}"
    if [ -f "$b" ]; then echo "$b"; return 0; fi
    [ -d "$b" ] || return 1
    # newest .xctestrun under the build dir
    local f newest=""
    while IFS= read -r f; do
        if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest="$f"; fi
    done < <(find "$b" -maxdepth 6 -name '*.xctestrun' 2>/dev/null)
    [ -n "$newest" ] && echo "$newest"
}

usb_devices() {  # lines "<ConnectionType> <SerialNumber>" from usbmuxd (read-only)
    python3 - "$HERE" <<'PY' 2>/dev/null
import sys
sys.path.insert(0, sys.argv[1])
import usbfwd
for d in usbfwd.list_devices():
    p = d.get("Properties", {})
    print(p.get("ConnectionType", "?"), p.get("SerialNumber", "?"))
PY
}

pick_udid() {
    [ -n "$UDID" ] && return 0
    local list usb net n
    list="$(usb_devices)"
    usb="$(printf '%s\n' "$list" | awk '$1 == "USB" { print $2 }' | sort -u)"
    net="$(printf '%s\n' "$list" | awk '$1 != "USB" && NF { print $2 }' | sort -u)"
    n="$(printf '%s\n' "$usb" | grep -c .)"
    if [ "$n" -eq 1 ]; then UDID="$usb"; return 0; fi
    if [ "$n" -gt 1 ]; then die "several USB devices — pass --udid:
$usb" 64; fi
    if [ -n "$net" ]; then
        die "no USB device; usbmux only sees these over Wi-Fi: $(echo $net)
Likely cause: The phone is not on USB (Wi-Fi only): usbmux cannot forward to it.
Fix:          Connect the cable, unlock, accept the trust prompt." 2
    fi
    die "no device at all in usbmux (cable, unlock, trust prompt?)" 2
}

describe_pids() { local p; for p in "$@"; do ps -o pid=,etime=,command= -p "$p" 2>/dev/null | cut -c1-160 | sed 's/^/    /'; done; }

# ---------------------------------------------------------------- subcommands
cmd_status() {
    local owners role pid rc=1
    for role in runner fwd; do
        pid="$(recorded "$role")"
        if [ -z "$pid" ]; then say "$role: not started by up.sh"
        elif is_ours_alive "$role"; then say "$role: running (pid $pid, ours)"
        else say "$role: recorded pid $pid is gone"; fi
    done
    [ -f "$(PIDFILE)" ] && awk '$1 == "udid" { print "up: udid: " $2 }' "$(PIDFILE)"
    owners="$(port_owners)"
    if [ -n "$owners" ]; then
        say "port $PORT is held by:"; describe_pids $owners
    else
        say "port $PORT: nothing listening"
    fi
    if status_ok; then say "/status: ok"; rc=0; else say "/status: no answer on 127.0.0.1:$PORT"; fi
    [ -f "$(RLOG)" ] && say "logs: $(RLOG)  $(FLOG)"
    return $rc
}

cmd_down() {
    stop_ours
    local owners; owners="$(port_owners)"
    if [ -n "$owners" ]; then say "port $PORT still held by (not started by up.sh, left alone):"; describe_pids $owners; fi
    return 0
}

cmd_start() {
    local xctestrun owners others p pid_r pid_f t0 hinted=0 elapsed
    xctestrun="$(find_xctestrun)"
    [ -n "$xctestrun" ] && [ -f "$xctestrun" ] || die "no driver build (*.xctestrun) in ${DRIVER_BUILD:-$HOME/.maestro/maestro-iphoneos-driver-build} — build it first: references/setup.md#xcuitest-driver" 2

    # Reuse what we started if it is alive, for this phone, and answering.
    if [ -f "$(PIDFILE)" ]; then
        local was; was="$(recorded udid)"
        if is_ours_alive runner && is_ours_alive fwd && { [ -z "$UDID" ] || [ "$UDID" = "$was" ]; } && status_ok; then
            say "already up on 127.0.0.1:$PORT (ours, udid $was)"; return 0
        fi
        say "previous runner/forwarder not healthy — restarting"
        stop_ours
    fi

    owners="$(port_owners)"
    if [ -n "$owners" ]; then
        echo "up: port $PORT is held by a process up.sh did not start:" >&2
        describe_pids $owners >&2
        echo "up: often a forwarder left over from another project. Stop it yourself if it is stale, or use --port <other>." >&2
        return 3
    fi

    pick_udid
    others="$(pgrep -f "test-without-building.*$UDID" 2>/dev/null || true)"
    if [ -n "$others" ]; then
        echo "up: another driver runner is already running for $UDID (one runner per phone; they knock each other off):" >&2
        describe_pids $others >&2
        echo "up: stop it if it is stale (it may belong to another session), then run up.sh again." >&2
        return 3
    fi

    mkdir -p "$STATE"
    : > "$(RLOG)"; : > "$(FLOG)"
    say "runner: $xctestrun -> $UDID, port $PORT"
    TEST_RUNNER_PORT="$PORT" nohup ${XCODEBUILD:-xcodebuild} test-without-building \
        -xctestrun "$xctestrun" -destination "id=$UDID" > "$(RLOG)" 2>&1 < /dev/null &
    pid_r=$!
    if [ -n "${USBFWD:-}" ]; then
        nohup $USBFWD --udid "$UDID" "$PORT" > "$(FLOG)" 2>&1 < /dev/null &
    else
        nohup python3 "$HERE/usbfwd.py" --udid "$UDID" "$PORT" > "$(FLOG)" 2>&1 < /dev/null &
    fi
    pid_f=$!
    disown "$pid_r" "$pid_f" 2>/dev/null  # no "Terminated" job noise when we stop them
    printf 'runner %s\nfwd %s\nudid %s\nport %s\n' "$pid_r" "$pid_f" "$UDID" "$PORT" > "$(PIDFILE)"

    t0=$SECONDS
    while :; do
        elapsed=$((SECONDS - t0))
        if status_ok; then
            say "up on 127.0.0.1:$PORT after ${elapsed}s (runner pid $pid_r, forwarder pid $pid_f)"
            say "logs: $(RLOG)  $(FLOG)"
            return 0
        fi
        if ! kill -0 "$pid_r" 2>/dev/null; then say "runner exited after ${elapsed}s"; break; fi
        if ! kill -0 "$pid_f" 2>/dev/null; then say "forwarder exited after ${elapsed}s"; break; fi
        if grep -q -E 'TEST EXECUTE FAILED|Testing failed' "$(RLOG)" 2>/dev/null; then say "runner failed after ${elapsed}s"; break; fi
        if [ $hinted -eq 0 ] && grep -q -i -E 'device is locked|Unlock .+ to Continue' "$(RLOG)" 2>/dev/null; then
            say "the phone is locked — unlock it now; still waiting"; hinted=1
        fi
        if [ "$elapsed" -ge "$TIMEOUT" ]; then say "no /status after ${TIMEOUT}s"; break; fi
        [ $((elapsed % 15)) -eq 0 ] && [ "$elapsed" -gt 0 ] && say "waiting for /status (${elapsed}s)"
        sleep 1
    done
    diagnose "$(RLOG)" "$(FLOG)"
    stop_ours
    say "logs kept: $(RLOG)  $(FLOG)"
    return 1
}

# ---------------------------------------------------------------- main
SUB="start"
case "${1:-}" in start|status|down|diagnose) SUB="$1"; shift ;; -h|--help) sed -n '2,26p' "$0"; exit 0 ;; esac
if [ "$SUB" = "diagnose" ]; then
    [ $# -ge 1 ] || die "usage: up.sh diagnose <runner.log> [forwarder.log]" 64
    diagnose "$@"; exit $?
fi
while [ $# -gt 0 ]; do
    case "$1" in
        --udid) UDID="${2:?--udid needs a value}"; shift 2 ;;
        --port) PORT="${2:?--port needs a value}"; shift 2 ;;
        --timeout) TIMEOUT="${2:?--timeout needs a value}"; shift 2 ;;
        *) die "unknown argument: $1 (see --help)" 64 ;;
    esac
done
case "$PORT" in ''|*[!0-9]*) die "port must be a number: $PORT" 64 ;; esac
"cmd_$SUB"
