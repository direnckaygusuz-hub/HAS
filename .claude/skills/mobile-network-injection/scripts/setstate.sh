#!/bin/bash
# setstate.sh — switch the injected state; inject.py picks it up on the next response.
#
# Usage:  ./setstate.sh <mode> [key=value ...]    e.g. ./setstate.sh delayed minutes=45
#         ./setstate.sh <mode> replay=true        serve fixtures/<rule>.json, then apply <mode>
#         ./setstate.sh off                       back to live data: {"mode":"off","replay":false}
#         ./setstate.sh                           print the current state
# Values are parsed as JSON when they can be (45, true, null, "x"), otherwise kept as strings.
# Keys from the previous state are kept (so replay=true and IDs persist) except on `off`,
# which resets the file. Written to a temp file and renamed, so inject.py never reads half a file.
# Env:    INJECT_STATE  control file (default <this dir>/state.json) — must match inject.py's.
# Nothing to edit here per project.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CFG="${INJECT_STATE:-$DIR/state.json}"
if [[ $# -eq 0 ]]; then { cat "$CFG" && echo; } 2>/dev/null || echo '{"mode": "off", "replay": false}  (no state file yet)'; exit 0; fi
python3 - "$CFG" "$@" <<'PY'
import json, os, sys, tempfile
cfg, mode, pairs = sys.argv[1], sys.argv[2], sys.argv[3:]
state = {"mode": "off", "replay": False}
if mode != "off":
    try:
        with open(cfg) as fh:
            state.update(json.load(fh))
    except Exception:
        pass
state["mode"] = mode
for pair in pairs:
    if "=" not in pair:
        sys.exit(f"setstate: expected key=value, got {pair!r}")
    key, raw = pair.split("=", 1)
    try:
        state[key] = json.loads(raw)
    except ValueError:
        state[key] = raw
os.makedirs(os.path.dirname(os.path.abspath(cfg)), exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(cfg)), suffix=".tmp")
with os.fdopen(fd, "w") as fh:
    json.dump(state, fh, indent=1)
os.replace(tmp, cfg)
print(json.dumps(state))
PY
