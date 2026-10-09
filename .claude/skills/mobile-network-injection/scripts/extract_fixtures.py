"""extract_fixtures.py — turn a recorded .mitm capture into replay fixtures.

What:  for every rule in inject.py's RULES, finds the flows whose URL matches its pattern
       and writes the LATEST 2xx JSON response body to fixtures/<rule name>.json — the
       file inject.py serves when replay is on. Rules with no match are reported.
       Flows inject.py rewrote (it marks them in the capture) are skipped, so only real
       backend bodies become fixtures.
How:   needs mitmproxy's Python. The form that works with every install (pipx, brew,
       standalone binary) is to run it as an addon over the capture, with no proxy:
           mitmdump -nr capture.mitm -s extract_fixtures.py
       If `import mitmproxy` works in some Python (e.g. the pipx venv's), this also works:
           <that python> extract_fixtures.py capture.mitm [fixtures_dir]
Env:   INJECT_FIXTURES  output directory (default <this dir>/fixtures), same as inject.py.
Edit:  nothing — patterns come from RULES in inject.py (in this same directory).
Record while the backend has real data, extract, then check the fixtures into the project.
"""
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _rules():
    spec = importlib.util.spec_from_file_location("inject_rules", os.path.join(HERE, "inject.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.RULES


class Extractor:
    def __init__(self, out_dir=None):
        self.out_dir = os.path.abspath(out_dir or os.environ.get(
            "INJECT_FIXTURES", os.path.join(HERE, "fixtures")))
        self.rules = _rules()
        self.written = {}                                  # rule name -> (url, count)
        self.skipped = 0

    def response(self, flow):
        if flow.response is None or not 200 <= flow.response.status_code < 300:
            return
        if (getattr(flow, "comment", "") or "").startswith("inject:"):
            self.skipped += 1                          # body was rewritten/replayed by inject.py
            return
        url = flow.request.pretty_url
        rule = next((r for r in self.rules if re.search(r["pattern"], url)), None)
        if rule is None:
            return
        try:
            body = json.loads(flow.response.get_text())
        except (ValueError, TypeError):
            return
        os.makedirs(self.out_dir, exist_ok=True)
        with open(os.path.join(self.out_dir, f"{rule['name']}.json"), "w") as fh:
            json.dump(body, fh, indent=1)              # later flows overwrite: latest wins
        count = self.written.get(rule["name"], (None, 0))[1] + 1
        self.written[rule["name"]] = (url, count)

    def done(self):
        for r in self.rules:
            if r["name"] in self.written:
                url, n = self.written[r["name"]]
                print(f"fixture {r['name']}.json <- {url} (latest of {n})", file=sys.stderr)
            else:
                print(f"fixture {r['name']}.json: NO matching 2xx JSON flow", file=sys.stderr)
        if self.skipped:
            print(f"skipped {self.skipped} flow(s) rewritten by inject.py", file=sys.stderr)
        print(f"fixtures dir: {self.out_dir}", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: extract_fixtures.py capture.mitm [fixtures_dir]   "
                 "(or: mitmdump -nr capture.mitm -s extract_fixtures.py)")
    try:
        from mitmproxy import io, http
    except ImportError:
        sys.exit("mitmproxy is not importable from this Python; run instead:\n"
                 f"  mitmdump -nr {sys.argv[1]} -s {os.path.abspath(__file__)}")
    ex = Extractor(sys.argv[2] if len(sys.argv) > 2 else None)
    with open(sys.argv[1], "rb") as fh:
        for flow in io.FlowReader(fh).stream():
            if isinstance(flow, http.HTTPFlow):
                ex.response(flow)
    ex.done()
else:
    addons = [Extractor()]
