#!/usr/bin/env python3
"""step.py — one test step through the driver: act, wait, save a screenshot, print the
visible tree. The evidence trail of a driven session is a folder of these.

qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.

Prerequisites: driver running and forwarded (`up.sh`); ios_driver.py next to this file.
Usage:
  step.py <name> [tap <label> | tapxy <x> <y> | back | swipe x1 y1 x2 y2 [sec] | none]
    -> <evidence dir>/<name>.png, and the visible elements on stdout
Env:  IOS_DRIVER_PORT (22087), IOS_APP_ID (bundle ID whose hierarchy is read),
      EVIDENCE_DIR (default ./evidence), WAIT (seconds after the action, default 2.5)
`back` is an edge swipe from the left; it does nothing on a screen without a back gesture.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ios_driver import Driver, DriverError, visible  # noqa: E402


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 64
    name, act, args = argv[0], (argv[1] if len(argv) > 1 else "none"), argv[2:]
    d = Driver(app_id=os.environ.get("IOS_APP_ID"))
    out_dir = os.environ.get("EVIDENCE_DIR", "evidence")
    os.makedirs(out_dir, exist_ok=True)
    try:
        els, screen = d.elements()
        w, h = screen.get("Width") or 390, screen.get("Height") or 844
        if act == "tap":
            e = d.tap(" ".join(args))
            print(f"tapped {e['text']!r} at {e['x']},{e['y']}")
        elif act == "tapxy":
            d.touch(float(args[0]), float(args[1]))
        elif act == "back":
            d.swipe(3, h / 2, w * 0.75, h / 2, 0.3)
        elif act == "swipe":
            nums = list(map(float, args))
            d.swipe(*nums[:4], duration=nums[4] if len(nums) > 4 else 0.3)
        elif act != "none":
            print(f"unknown action {act!r}", file=sys.stderr)
            return 64
        time.sleep(float(os.environ.get("WAIT", "2.5")))
        path = os.path.join(out_dir, f"{name}.png")
        with open(path, "wb") as f:
            f.write(d.screenshot())
        print("saved", path)
        els, screen = d.elements()
        for e in visible(els, screen):
            print(f'({e["x"]:4},{e["y"]:4}) t{e["type"]:<3} {e["text"]!r} {e["identifier"]}')
    except DriverError as e:
        print(f"step: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
