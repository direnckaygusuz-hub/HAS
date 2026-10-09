#!/usr/bin/env python3
"""hit_area.py — does a small target react to a tap *outside* its reported frame? Taps the
centre first (control: it must react, or the check means nothing), then N pt left / right /
above / below the centre, and after each tap compares the visible screen with the state
before. The accessibility frame of a small button is often smaller than what a finger hits;
this tells "44 pt hit area, 30 pt frame" (fine) from "30 pt and that's it" (a finding).

qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.

Prerequisites: driver running and forwarded (`up.sh`); ios_driver.py next to this file.
Usage:
  hit_area.py <label> [--offset 20] [--sides left,right,above,below] [--open LABEL]...
              [--reset LABEL]... [--ignore REGEX] [--wait 2.5] [--dry-run]
  --open LABEL   tapped in order before a probe whenever the target isn't on screen
                 (how to get back to the screen after a tap that reacted)
  --reset LABEL  tapped in order after a probe that reacted (e.g. Back), before --open
  --ignore RE    texts to leave out of the before/after comparison (clocks, countdowns)
  --dry-run      print the probe points, tap nothing
Options: --app BUNDLE_ID (env IOS_APP_ID), --port (env IOS_DRIVER_PORT).
A probe point inside the reported frame says nothing about the hit area; it is marked so.
Never point it at anything with side effects (call, pay, submit, delete): every probe taps.
"""
import argparse
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ios_driver import Driver, DriverError, find, visible  # noqa: E402

SIDES = {"left": (-1, 0), "right": (1, 0), "above": (0, -1), "below": (0, 1)}


def probe_points(e, offset, sides):
    """[(name, x, y, inside_frame)] — the centre first, then each side at `offset` pt."""
    f = e["frame"]
    cx, cy = f["X"] + f["Width"] / 2, f["Y"] + f["Height"] / 2
    pts = [("centre", cx, cy, True)]
    for s in sides:
        dx, dy = SIDES[s]
        x, y = cx + dx * offset, cy + dy * offset
        inside = f["X"] <= x <= f["X"] + f["Width"] and f["Y"] <= y <= f["Y"] + f["Height"]
        pts.append((s, x, y, inside))
    return pts


def signature(elements, ignore=None):
    """What 'the screen' is for the comparison: the set of visible texts and identifiers."""
    rx = re.compile(ignore) if ignore else None
    return frozenset((e["text"], e["identifier"]) for e in elements
                     if (e["text"] or e["identifier"]) and not (rx and rx.search(e["text"])))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("label")
    ap.add_argument("--offset", type=float, default=20.0, help="pt from the centre (default 20: inside a 44 pt square)")
    ap.add_argument("--sides", default="left,right,above,below")
    ap.add_argument("--open", action="append", default=[], metavar="LABEL")
    ap.add_argument("--reset", action="append", default=[], metavar="LABEL")
    ap.add_argument("--ignore", help="regex of texts to ignore in the comparison")
    ap.add_argument("--wait", type=float, default=2.5, help="seconds after each tap (default 2.5)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--app", default=os.environ.get("IOS_APP_ID"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("IOS_DRIVER_PORT", "22087")))
    a = ap.parse_args(argv)
    sides = [s for s in a.sides.split(",") if s]
    bad = [s for s in sides if s not in SIDES]
    if bad:
        ap.error(f"unknown side(s) {bad}; use {','.join(SIDES)}")
    d = Driver(port=a.port, app_id=a.app)

    def screen():
        return visible(*d.elements())

    def target():
        return find(screen(), a.label)

    def tap_seq(labels):
        for lab in labels:
            d.tap(lab)
            time.sleep(a.wait)

    try:
        t = target()
        if not t and a.open:
            tap_seq(a.open)
            t = target()
        if not t:
            print(f"hit_area: {a.label!r} not on screen", file=sys.stderr)
            return 1
        f = t["frame"]
        print(f"target {t['text']!r} {t['identifier']} frame {f['Width']:.1f}x{f['Height']:.1f} at "
              f"({f['X']:.0f},{f['Y']:.0f})")
        results = []
        for name, x, y, inside in probe_points(t, a.offset, sides):
            note = " (inside the frame)" if inside and name != "centre" else ""
            if a.dry_run:
                print(f"  {name:6} would tap ({x:.0f},{y:.0f}){note}")
                continue
            t = target()
            if not t and a.open:
                tap_seq(a.open)
                t = target()
            if not t:
                print(f"  {name:6} skipped: target not on screen (give --open)")
                continue
            before = signature(screen(), a.ignore)
            d.touch(x, y)
            time.sleep(a.wait)
            after = signature(screen(), a.ignore)
            reacted = after != before
            results.append((name, reacted))
            print(f"  {name:6} tap ({x:.0f},{y:.0f}){note}: {'REACTS' if reacted else 'no reaction'}")
            if reacted and a.reset:
                tap_seq(a.reset)
        if results and results[0] == ("centre", False):
            print("centre tap did not react: the comparison can't see this target's effect — "
                  "check by eye (screenshots) or use --ignore / a different target")
    except DriverError as e:
        print(f"hit_area: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
