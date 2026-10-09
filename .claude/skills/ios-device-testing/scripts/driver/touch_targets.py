#!/usr/bin/env python3
"""touch_targets.py — measure every interactive element on the current screen against
44x44 pt (Apple HIG / WCAG 2.5.5 AAA) and 24x24 pt (WCAG 2.5.8 AA, with its spacing
exception: an undersized target passes when a 24 pt circle on its centre touches no other
target or other undersized target's circle). Reads the driver's hierarchy, so it measures
the accessibility frame — confirm a borderline FAIL with hit_area.py before reporting.

qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.

Prerequisites: driver running and forwarded (`up.sh`); ios_driver.py next to this file.
Usage:
  touch_targets.py [--screen NAME] [--tsv results.tsv] [--shot DIR]     live, current screen
  touch_targets.py --hierarchy saved.json [--screen NAME]               a saved viewHierarchy
Options: --app BUNDLE_ID (env IOS_APP_ID), --port (env IOS_DRIVER_PORT), --aaa 44, --aa 24.
Navigate between calls yourself (ios_driver.py tap / step.py); --tsv appends one row per
element, so one file collects a whole walk. Status bar and keyboard keys are skipped.
Exit code: 0 always (a FAIL is a finding, not an error) unless the driver can't be reached.
"""
import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ios_driver import Driver, DriverError, flatten, screen_frame, visible  # noqa: E402

# XCUIElement.ElementType raw values a user can act on
INTERACTIVE = {9: "button", 10: "radio", 12: "checkbox", 13: "disclosure", 14: "popup", 15: "combobox",
               16: "menuButton", 17: "toolbarButton", 33: "slider", 37: "segmented", 39: "pickerWheel",
               40: "switch", 41: "toggle", 42: "link", 45: "searchField", 49: "textField",
               50: "secureField", 51: "datePicker", 52: "textView", 54: "menuItem", 79: "stepper"}
COLUMNS = ("screen", "type", "label", "identifier", "width", "height", "44x44", "24x24", "spacing", "x", "y")


def _rect_circle_hit(f, cx, cy, r):
    nx = min(max(cx, f["X"]), f["X"] + f["Width"])
    ny = min(max(cy, f["Y"]), f["Y"] + f["Height"])
    return math.hypot(nx - cx, ny - cy) < r


def measure(elements, screen, screen_name="", aaa=44.0, aa=24.0):
    """Rows (dicts with COLUMNS) for the visible interactive elements, de-duplicated."""
    targets, seen = [], set()
    for e in visible(elements, screen):
        if e["type"] not in INTERACTIVE or e.get("keyboard"):
            continue
        f = e["frame"]
        key = (e["text"], e["identifier"], round(f["X"]), round(f["Y"]), round(f["Width"]), round(f["Height"]))
        if key in seen:
            continue
        seen.add(key)
        targets.append(e)
    rows = []
    for e in targets:
        f = e["frame"]
        w, h = round(f["Width"], 1), round(f["Height"], 1)
        small = min(w, h) < aa
        spacing = ""
        if small:  # WCAG 2.5.8 spacing exception
            cx, cy, r = f["X"] + f["Width"] / 2, f["Y"] + f["Height"] / 2, aa / 2
            clash = False
            for o in targets:
                if o is e:
                    continue
                of = o["frame"]
                if _rect_circle_hit(of, cx, cy, r):
                    clash = True
                    break
                if min(of["Width"], of["Height"]) < aa:
                    ox, oy = of["X"] + of["Width"] / 2, of["Y"] + of["Height"] / 2
                    if math.hypot(ox - cx, oy - cy) < aa:
                        clash = True
                        break
            spacing = "FAIL" if clash else "PASS"
        rows.append({"screen": screen_name, "type": INTERACTIVE[e["type"]],
                     "label": (e["text"] or "(no label)")[:80], "identifier": e["identifier"],
                     "width": w, "height": h,
                     "44x44": "PASS" if min(w, h) >= aaa else "FAIL",
                     "24x24": "PASS" if not small else ("PASS*" if spacing == "PASS" else "FAIL"),
                     "spacing": spacing, "x": round(f["X"]), "y": round(f["Y"])})
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--screen", default="screen", help="name for this screen in the output")
    ap.add_argument("--tsv", help="append rows to this TSV (header written when new)")
    ap.add_argument("--shot", help="also save a screenshot <DIR>/<screen>.png (live only)")
    ap.add_argument("--hierarchy", help="measure a saved viewHierarchy JSON instead of the live screen")
    ap.add_argument("--app", default=os.environ.get("IOS_APP_ID"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("IOS_DRIVER_PORT", "22087")))
    ap.add_argument("--aaa", type=float, default=44.0)
    ap.add_argument("--aa", type=float, default=24.0)
    a = ap.parse_args(argv)
    try:
        if a.hierarchy:
            with open(a.hierarchy) as fh:
                h = json.load(fh)
            root = h.get("axElement", h)
            els, screen = flatten(root), screen_frame(root)
        else:
            d = Driver(port=a.port, app_id=a.app)
            els, screen = d.elements()
            if a.shot:
                os.makedirs(a.shot, exist_ok=True)
                with open(os.path.join(a.shot, f"{a.screen}.png"), "wb") as fh:
                    fh.write(d.screenshot())
    except DriverError as e:
        print(f"touch_targets: {e}", file=sys.stderr)
        return 2
    rows = measure(els, screen, a.screen, a.aaa, a.aa)
    for r in rows:
        print(f"  {r['44x44']:4} {r['24x24']:5} {r['width']:6}x{r['height']:<6} {r['type']:13} "
              f"{r['label']!r} {r['identifier']}")
    n44 = sum(r["44x44"] == "FAIL" for r in rows)
    n24 = sum(r["24x24"] == "FAIL" for r in rows)
    print(f"{a.screen}: {len(rows)} targets, {n44} under {a.aaa:g}x{a.aaa:g}, {n24} fail {a.aa:g} pt "
          f"(PASS* = under {a.aa:g} pt but passes on spacing)")
    if a.tsv:
        new = not os.path.exists(a.tsv) or os.path.getsize(a.tsv) == 0
        with open(a.tsv, "a") as fh:
            if new:
                fh.write("\t".join(COLUMNS) + "\n")
            for r in rows:
                fh.write("\t".join(str(r[c]) for c in COLUMNS) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
