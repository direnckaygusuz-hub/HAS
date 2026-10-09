"""inject.py — mitmproxy addon that rewrites or replays selected JSON API responses.

What:  on every flow, re-reads a small JSON control file and, for URLs that match a
       rule in RULES, (a) optionally answers with a recorded fixture instead of the live
       backend and (b) lets the rule rewrite the body for the current mode. Every rewrite is logged
       as one line. Everything else passes through untouched.
How:   run it only through mitmdump (it uses mitmdump's bundled Python):
           mitmdump --listen-port 8080 -s inject.py -w capture.mitm      (or ./run.sh)
       and switch state while it runs, no restart:
           ./setstate.sh delayed minutes=45      ./setstate.sh off
Edit:  a project edits ONLY the RULES section below (rule functions + the RULES table).
       The helpers and the plumbing are generic; leave them alone.

Control file (default <this dir>/state.json, env INJECT_STATE):
    {"mode": "off", "replay": false, ...any keys your rules read...}
    mode "off" + replay false  -> live data, nothing touched.
    replay true                -> matching URLs are answered from fixtures/<rule name>.json
                                  (without asking the backend), with the rule's timestamp
                                  keys refreshed to now; then the mode's rule is applied.
Env:   INJECT_STATE     control file         (default <this dir>/state.json)
       INJECT_FIXTURES  fixtures directory   (default <this dir>/fixtures)
       INJECT_LOG       rewrite log          (default <this dir>/inject.log)
       BACKEND_TZ       backend's IANA zone  (default UTC), used by backend_now()
Relative env paths resolve against the current directory.
"""
import copy
import datetime as dt
import json
import os
import re
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
CONTROL_FILE = os.path.abspath(os.environ.get("INJECT_STATE", os.path.join(HERE, "state.json")))
FIXTURES_DIR = os.path.abspath(os.environ.get("INJECT_FIXTURES", os.path.join(HERE, "fixtures")))
LOG_FILE = os.path.abspath(os.environ.get("INJECT_LOG", os.path.join(HERE, "inject.log")))
BACKEND_TZ = os.environ.get("BACKEND_TZ", "UTC")


# ============================================================================ helpers

def backend_now(tz_name=BACKEND_TZ):
    """Current time in the backend's zone. Derive offsets from this, never hard-code
    them: a fixed '-7 hours' breaks at the next daylight-saving switch."""
    return dt.datetime.now(ZoneInfo(tz_name))


_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")


def _fresh_value(value, now):
    """`value` rewritten to `now`, keeping its format (ISO string or epoch number)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value > 1e11:                                   # epoch milliseconds
            return int(now.timestamp() * 1000)
        if value > 1e8:                                    # epoch seconds
            return int(now.timestamp())
        return value
    if isinstance(value, str) and _ISO_RE.match(value):
        try:
            old = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
        new = now.astimezone(old.tzinfo) if old.tzinfo else now.replace(tzinfo=None)
        timespec = "seconds" if "." not in value else "milliseconds"
        out = new.isoformat(timespec=timespec)
        if value.endswith("Z"):
            out = out.replace("+00:00", "Z")
        if " " in value[:11]:
            out = out.replace("T", " ", 1)
        return out
    return value


def refresh_timestamps(obj, keys, now=None):
    """Set every field named in `keys`, anywhere in `obj`, to `now` (default: aware
    UTC now). Handles ISO-8601 strings (offset and 'Z' kept) and epoch s/ms numbers.
    Mutates and returns `obj`. Apps drop replayed data whose timestamps are stale."""
    now = now or dt.datetime.now(dt.timezone.utc)
    keys = set(keys)
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in keys and not isinstance(v, (dict, list)):
                obj[k] = _fresh_value(v, now)
            else:
                refresh_timestamps(v, keys, now)
    elif isinstance(obj, list):
        for item in obj:
            refresh_timestamps(item, keys, now)
    return obj


def clone_entry(entries, index, id_keys):
    """Deep copy of entries[index] with its id fields made unique within `entries`:
    ints become max+1, strings get a '-clone<N>' suffix. Returns the clone; the caller
    inserts it where it belongs, because position in an array often carries meaning.
    Use it to synthesize an entry the upstream feed left out."""
    clone = copy.deepcopy(entries[index])
    for key in id_keys:
        if key not in clone:
            continue
        taken = [e.get(key) for e in entries if isinstance(e, dict)]
        if isinstance(clone[key], int) and not isinstance(clone[key], bool):
            clone[key] = max(v for v in taken if isinstance(v, int)) + 1
        else:
            n = 1
            while f"{clone[key]}-clone{n}" in taken:
                n += 1
            clone[key] = f"{clone[key]}-clone{n}"
    return clone


# ============================================================================ RULES
# The only part a project edits. A rule function receives the flow, the parsed JSON
# body (live, or the fixture on replay) and the control-file dict, and returns the body
# to send. Return it unchanged for modes it doesn't handle.
#
# RULES entries:
#   name        fixture file name (fixtures/<name>.json) and the name in the log
#   pattern     regex searched in the full URL
#   fn          (flow, body_json, state) -> body_json
#   timestamps  keys refreshed to now when replaying from a fixture

def example_order_status(flow, body, state):
    """EXAMPLE ONLY — a fake delivery API, GET /api/v1/orders/<id>/status returning
    {"orderId", "status", "etaMinutes", "updatedAt", "stops": [...]}. Replace it.
      delayed [minutes=N]   status "delayed", etaMinutes N (default 30), etaAt from backend clock
      delivered             status "delivered", etaMinutes 0
      extra_stop            one more stop, cloned from the last real one
    """
    mode = state.get("mode")
    if mode == "delayed":
        minutes = int(state.get("minutes", 30))
        body["status"] = "delayed"
        body["etaMinutes"] = minutes
        body["etaAt"] = (backend_now() + dt.timedelta(minutes=minutes)).isoformat(timespec="seconds")
    elif mode == "delivered":
        body["status"] = "delivered"
        body["etaMinutes"] = 0
    elif mode == "extra_stop" and body.get("stops"):
        body["stops"].append(clone_entry(body["stops"], -1, ["id"]))
    return body


RULES = [
    {"name": "order_status", "pattern": r"/api/v1/orders/[^/]+/status(\?|$)",
     "fn": example_order_status, "timestamps": ["updatedAt"]},
]
# ============================================================================ end RULES


def _state():
    try:
        with open(CONTROL_FILE) as fh:
            return json.load(fh)
    except Exception:
        return {"mode": "off", "replay": False}


def _log(line):
    with open(LOG_FILE, "a") as fh:
        fh.write(f"{dt.datetime.now().isoformat(timespec='seconds')} {line}\n")


def _flatten(obj, prefix=""):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            out.update(_flatten(v, f"{prefix}.{k}" if prefix else str(k)))
        return out
    if isinstance(obj, list):
        out = {f"{prefix}#len": len(obj)}
        for i, v in enumerate(obj):
            out.update(_flatten(v, f"{prefix}[{i}]"))
        return out
    return {prefix: obj}


def _changes(before, after, limit=8):
    a, b = _flatten(before), _flatten(after)
    diffs = [f"{k}: {json.dumps(a.get(k, '<none>'))} -> {json.dumps(b.get(k, '<none>'))}"
             for k in sorted(set(a) | set(b)) if a.get(k, "<none>") != b.get(k, "<none>")]
    more = f" (+{len(diffs) - limit} more)" if len(diffs) > limit else ""
    return "; ".join(diffs[:limit]) + more if diffs else "no change"


def _load_fixture(name):
    path = os.path.join(FIXTURES_DIR, f"{name}.json")
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception as e:
        _log(f"FIXTURE_MISSING rule={name} path={path} ({type(e).__name__}) - serving live")
        return None


def _match(flow):
    url = flow.request.pretty_url
    return url, next((r for r in RULES if re.search(r["pattern"], url)), None)


def request(flow):
    """Replay: answer from the fixture before the request leaves, so replay also works
    when the backend is down or has nothing to return."""
    url, rule = _match(flow)
    if rule is None or not _state().get("replay"):
        return
    body = _load_fixture(rule["name"])
    if body is None:
        return                                             # logged; the live backend answers
    refresh_timestamps(body, rule.get("timestamps", []))
    from mitmproxy import http                             # only exists inside mitmdump
    flow.response = http.Response.make(200, json.dumps(body), {"content-type": "application/json"})
    flow.metadata["inject_source"] = "replay"


def response(flow):
    url, rule = _match(flow)
    if rule is None:
        return
    state = _state()
    mode = state.get("mode", "off")
    source = flow.metadata.get("inject_source", "live")
    if mode == "off" and source == "live":
        return
    try:
        try:
            body = json.loads(flow.response.get_text())
        except (ValueError, TypeError):
            _log(f"SKIP mode={mode} rule={rule['name']} url={url} - body is not JSON")
            return
        before = copy.deepcopy(body)
        if mode != "off":
            body = rule["fn"](flow, body, state)
        flow.response.status_code = 200
        flow.response.headers["content-type"] = "application/json"
        flow.response.text = json.dumps(body)
        # Recorded in the .mitm capture, so extract_fixtures.py skips rewritten bodies.
        flow.comment = f"inject: mode={mode} source={source} rule={rule['name']}"
        fixture = f" fixture={rule['name']}.json (timestamps refreshed: " \
                  f"{','.join(rule.get('timestamps', [])) or 'none'})" if source == "replay" else ""
        _log(f"mode={mode} source={source} rule={rule['name']} url={url}{fixture} "
             f"changes: {_changes(before, body)}")
    except Exception as e:
        _log(f"ERROR mode={mode} rule={rule['name']} url={url} {type(e).__name__}: {e}")
