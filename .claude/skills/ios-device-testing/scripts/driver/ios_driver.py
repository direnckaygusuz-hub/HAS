#!/usr/bin/env python3
"""ios_driver.py — small client for Maestro's XCUITest driver HTTP API on a physical
iPhone, bypassing the Maestro CLI (whose real-device path is unreliable). Importable
(`from ios_driver import Driver`) or used as a CLI.

qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.

Prerequisites: Python 3 standard library only. The driver runner must be running on the
phone and its port forwarded to the Mac — `./up.sh` (next to this file) starts both and
says why when it can't.

Usage:
  ios_driver.py status                     {"status":"ok"} when the driver answers
  ios_driver.py tree [--all]               visible labelled elements with centre points
  ios_driver.py find <label>               first visible match (exact before substring)
  ios_driver.py tap <label> | tap <x> <y>  tap an element by label, or a point
  ios_driver.py swipe x1 y1 x2 y2 [sec]    swipe
  ios_driver.py type <text>                type into the focused field
  ios_driver.py launch <bundleId> | kill <bundleId> | home
  ios_driver.py orientation portrait|landscapeLeft|landscapeRight|upsideDown
  ios_driver.py screenshot <file.png>
Options: --port (22087, env IOS_DRIVER_PORT), --host, --app BUNDLE_ID (env IOS_APP_ID;
the app whose hierarchy is read), --timeout (150 s; a long list can take over a minute to
serialise — a slow reply is not a hung app).

Traps handled: paged views keep off-screen copies of their elements, so matching uses only
elements whose centre lies inside the screen; the screen size comes from the application
element (type 2) — the hierarchy root is 0x0, in landscape too. Status-bar elements (and
the "◀ <other app>" back link) are dropped from matching, or a walk taps them. Exact
label/identifier matches win over substrings ("Close" must not hit "Closed"); identifiers
are matched too and can collide with labels, so check `tree` when a tap lands wrong.
Not handled: some scroll views report stale frames after a scroll — compare screenshots
(points = px / scale) before trusting a frame. Toggling VoiceOver or rotating can drop the
runner: `up.sh status` after either.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_PORT = int(os.environ.get("IOS_DRIVER_PORT", "22087"))
DEFAULT_TIMEOUT = 150
ORIENTATIONS = ("portrait", "landscapeLeft", "landscapeRight", "upsideDown")


class DriverError(RuntimeError):
    pass


class Driver:
    def __init__(self, host="127.0.0.1", port=DEFAULT_PORT, app_id=None, timeout=DEFAULT_TIMEOUT):
        self.base = f"http://{host}:{port}/"
        self.app_ids = [app_id] if app_id else []
        self.timeout = timeout

    # --- raw API ---------------------------------------------------------------
    def call(self, route, body=None, timeout=None, raw=False):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + route, data=data, method="POST" if data else "GET",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
                b = r.read()
        except urllib.error.HTTPError as e:
            raise DriverError(f"{route}: HTTP {e.code} {e.read()[:300]!r}") from None
        except (urllib.error.URLError, OSError) as e:
            reason = getattr(e, "reason", e)
            raise DriverError(f"cannot reach driver at {self.base} ({reason}) — runner dropped or never "
                              f"started? `up.sh status`, then `up.sh` to (re)start it") from None
        if raw:
            return b
        return json.loads(b) if b.strip() else {}

    def status(self):
        return self.call("status", timeout=5)

    def view_hierarchy(self):
        return self.call("viewHierarchy", {"appIds": self.app_ids, "excludeKeyboardElements": False})

    def touch(self, x, y, duration=None):
        return self.call("touch", {"x": x, "y": y, "duration": duration})

    def swipe(self, x1, y1, x2, y2, duration=0.3):
        return self.call("swipe", {"startX": x1, "startY": y1, "endX": x2, "endY": y2,
                                   "duration": duration, "appIds": self.app_ids})

    def input_text(self, text):
        return self.call("inputText", {"text": text, "appIds": self.app_ids})

    def launch_app(self, bundle_id):
        # Cold start is more reliable with `xcrun devicectl device process launch --terminate-existing`.
        return self.call("launchApp", {"bundleId": bundle_id})

    def terminate_app(self, bundle_id):
        return self.call("terminateApp", {"appId": bundle_id})

    def press_button(self, button="home"):
        return self.call("pressButton", {"button": button})

    def set_orientation(self, orientation):
        """portrait | landscapeLeft | landscapeRight | upsideDown (XCUIDevice, test session only)."""
        return self.call("setOrientation", {"orientation": orientation})

    def screenshot(self):
        return self.call("screenshot", raw=True)

    # --- helpers ---------------------------------------------------------------
    def elements(self, all_=False):
        """(elements, screen) — flattened hierarchy plus the screen frame (see screen_frame)."""
        h = self.view_hierarchy()
        root = h.get("axElement", h)
        return flatten(root, all_), screen_frame(root)

    def find(self, label):
        els, screen = self.elements()
        return find(visible(els, screen), label)

    def tap(self, label):
        e = self.find(label)
        if not e:
            raise DriverError(f"not found on screen: {label!r}")
        self.touch(e["x"], e["y"])
        return e


# XCUIElement.ElementType raw values used below.
APPLICATION, KEYBOARD, STATUS_BAR = 2, 19, 25
STATUS_BAR_IDS = {"breadcrumb"}  # the "◀ <other app>" back link in the status bar


def screen_frame(root):
    """Screen size in points: the first application element (type 2) with a real frame.
    The hierarchy root reports 0x0 (portrait and landscape), so it can't be used."""
    stack = [root]
    while stack:
        n = stack.pop(0)
        f = n.get("frame") or {}
        if n.get("elementType") == APPLICATION and f.get("Width", 0) > 0 and f.get("Height", 0) > 0:
            return f
        stack.extend(n.get("children") or [])
    return root.get("frame") or {}


def flatten(node, all_=False):
    """Walk the hierarchy; return dicts with text, centre x/y, frame, type, identifier, and
    flags `statusbar` / `keyboard` for elements inside the status bar / keyboard."""
    out = []

    def walk(n, in_sb, in_kb):
        et = n.get("elementType")
        in_sb = in_sb or et == STATUS_BAR or (n.get("identifier") or "") in STATUS_BAR_IDS
        in_kb = in_kb or et == KEYBOARD
        f = n.get("frame") or {}
        text = " | ".join(t for t in (n.get("label"), n.get("title"), n.get("value")) if t)
        if (text or n.get("identifier") or all_) and f.get("Width", 0) > 0 and f.get("Height", 0) > 0:
            out.append({"text": text, "label": n.get("label") or "", "identifier": n.get("identifier") or "",
                        "type": et, "frame": f, "statusbar": in_sb, "keyboard": in_kb,
                        "x": round(f["X"] + f["Width"] / 2), "y": round(f["Y"] + f["Height"] / 2)})
        for c in n.get("children") or []:
            walk(c, in_sb, in_kb)

    walk(node, False, False)
    return out


def visible(elements, screen, status_bar=False):
    """Keep elements whose centre lies inside the screen frame (drops off-screen pages) and,
    unless status_bar=True, drop status-bar elements (clock, battery, "◀ <app>" link)."""
    els = [e for e in elements if status_bar or not e.get("statusbar")]
    w, h = screen.get("Width", 0), screen.get("Height", 0)
    if not (w and h):
        return els
    x0, y0 = screen.get("X", 0), screen.get("Y", 0)
    return [e for e in els if x0 <= e["x"] <= x0 + w and y0 <= e["y"] <= y0 + h]


def find(elements, label):
    """Exact label / identifier / first text part first, then substring. Case-insensitive."""
    q = label.lower()
    for e in elements:
        if q in (e["label"].lower(), e["identifier"].lower(), e["text"].lower(), e["text"].split(" | ")[0].lower()):
            return e
    for e in elements:
        if q in e["text"].lower() or (e["identifier"] and q in e["identifier"].lower()):
            return e
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--app", default=os.environ.get("IOS_APP_ID"), help="bundle ID whose hierarchy is read")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="seconds per call (default 150)")
    ap.add_argument("command", choices=["status", "tree", "find", "tap", "swipe", "type",
                                        "launch", "kill", "home", "orientation", "screenshot"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--all", action="store_true",
                    help="tree: include unlabelled, off-screen and status-bar elements")
    a = ap.parse_args(argv)
    d = Driver(a.host, a.port, a.app, a.timeout)
    c, rest = a.command, a.args
    need = {"find": 1, "tap": 1, "swipe": 4, "type": 1, "launch": 1, "kill": 1, "orientation": 1,
            "screenshot": 1}
    if len(rest) < need.get(c, 0):
        ap.error(f"{c} needs {need[c]} argument(s)")
    if c == "orientation" and rest[0] not in ORIENTATIONS:
        ap.error(f"orientation: one of {', '.join(ORIENTATIONS)}")
    try:
        if c == "status":
            print(json.dumps(d.status()))
        elif c == "tree":
            els, screen = d.elements(a.all)
            print(f"# screen {screen.get('Width', 0):.0f}x{screen.get('Height', 0):.0f} pt")
            for e in (els if a.all else visible(els, screen)):
                flag = " [statusbar]" if e["statusbar"] else " [keyboard]" if e["keyboard"] else ""
                print(f"({e['x']:>4},{e['y']:>4}) t{e['type']} {e['text']!r} {e['identifier']}{flag}")
        elif c == "find":
            e = d.find(" ".join(rest))
            print(json.dumps(e) if e else "not found")
            return 0 if e else 1
        elif c == "tap":
            if len(rest) == 2 and all(r.replace(".", "", 1).isdigit() for r in rest):
                x, y = map(float, rest)
                d.touch(x, y)
            else:
                e = d.tap(" ".join(rest))
                x, y = e["x"], e["y"]
            print(f"tapped {x:.0f},{y:.0f}")
        elif c == "swipe":
            nums = list(map(float, rest[:5]))
            d.swipe(*nums[:4], duration=nums[4] if len(nums) > 4 else 0.3)
            print("swiped")
        elif c == "type":
            d.input_text(" ".join(rest))
            print("typed")
        elif c == "launch":
            d.launch_app(rest[0])
            print("launched")
        elif c == "kill":
            d.terminate_app(rest[0])
            print("terminated")
        elif c == "home":
            d.press_button("home")
            print("home")
        elif c == "orientation":
            d.set_orientation(rest[0])
            print("orientation", rest[0])
        elif c == "screenshot":
            with open(rest[0], "wb") as f:
                f.write(d.screenshot())
            print("saved", rest[0])
    except DriverError as e:
        print(f"ios_driver: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
