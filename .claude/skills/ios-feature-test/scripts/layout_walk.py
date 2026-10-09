#!/usr/bin/env python3
"""layout_walk.py — layout checks on the current iOS screen (or a saved viewHierarchy JSON),
read from the accessibility tree of Maestro's XCUITest driver:
  size_class      horizontalSizeClass x verticalSizeClass from the root (1 compact, 2 regular,
                  0 unspecified); when the root reports 0, the first descendant that reports one
  clipped_screen  text/control cut by the left/right screen edge (or the top/bottom edge when it is
                  not inside a scroll view); fully off-screen elements are only counted
  clipped_parent  text/control sticking out of its nearest container frame (scroll containers skipped)
  unsafe          text/control inside the safe-area insets (Dynamic Island, home indicator,
                  landscape side insets); bottom inset counts interactive elements only
  overlap         two different text elements whose frames overlap (> --overlap of the smaller one)
  truncated       label with "…" / "..." or a word split by a hyphen at a line end ("pay-")
  full_width      buttons running (almost) edge to edge (< --edge pt of side padding in total)

qa-toolkit 0.9.0 — copy into the project repo; compare with the plugin copy before trusting an old one.

PROVISIONAL: a tree-based "clipped" or "off-screen" result is a lead, not a finding, until it is
confirmed by hand or on the screenshot (--shot). Driver frames go stale after a scroll, and in
landscape driver swipes miss, so the tree can describe a layout that is not on the screen.
A clean "truncated" result proves nothing either: the accessibility label usually carries the full
string even when the label is visibly cut off — compare with the screenshot.

Prerequisites: driver running and forwarded (ios-device-testing `up.sh`); ios_driver.py next to
this file, in ./driver/, or in the plugin's skills/ios-device-testing/scripts/driver/.
Usage:
  layout_walk.py [--screen NAME] [--tsv out.tsv] [--shot DIR] [--texts]     live, current screen
  layout_walk.py --hierarchy saved.json [--screen NAME] [--tsv out.tsv]     a saved viewHierarchy
Options: --app BUNDLE_ID (env IOS_APP_ID), --port (env IOS_DRIVER_PORT, default 22087),
  --safe T,B,L,R safe-area insets in pt (default: Dynamic Island iPhones — portrait 59,34,0,0,
  landscape 0,21,59,59; picked by screen width > height), --edge 16, --overlap 0.2,
  --texts also list every visible text (copy checks).
Navigate between calls yourself (ios_driver.py tap / step.py); --tsv appends one row per finding
(screen, check, type, label, identifier, x, y, width, height, detail), so one file collects a walk.
--shot DIR saves <screen>.png and <screen>.json, so every flag can be checked against the pixels.
Exit code: 0 (a finding is not an error) unless the driver can't be reached (2).
"""
import argparse
import json
import os
import re
import sys

_here = os.path.dirname(os.path.abspath(__file__))
for _p in (_here, os.path.join(_here, "driver"),
           os.path.join(_here, "..", "..", "ios-device-testing", "scripts", "driver")):
    if os.path.exists(os.path.join(_p, "ios_driver.py")):
        sys.path.insert(0, _p)
        break
from ios_driver import Driver, DriverError, screen_frame  # noqa: E402

# XCUIElement.ElementType raw values
APPLICATION, WINDOW, KEYBOARD, STATUS_BAR, CELL = 2, 4, 19, 25, 75
SCROLLERS = {26: "table", 32: "collectionView", 46: "scrollView", 58: "webView"}
TEXT = {9: "button", 42: "link", 45: "searchField", 48: "staticText", 49: "textField",
        50: "secureField", 52: "textView"}
INTERACTIVE = {9, 10, 12, 13, 14, 15, 16, 17, 33, 37, 39, 40, 41, 42, 45, 49, 50, 51, 52, 54, 79}
CHECKED = set(TEXT) | INTERACTIVE
STATUS_BAR_IDS = {"breadcrumb"}
SC_NAMES = {0: "unspecified", 1: "compact", 2: "regular"}
CHECKS = ("clipped_screen", "clipped_parent", "unsafe", "overlap", "truncated", "full_width")
COLUMNS = ("screen", "check", "type", "label", "identifier", "x", "y", "width", "height", "detail")
TOL = 1.0  # pt of slack for rounding in frames


def collect(root):
    """Elements with a real frame, each with its ancestor chain; status bar and keyboard skipped."""
    out = []

    def walk(n, ancestors):
        et = n.get("elementType")
        if et in (STATUS_BAR, KEYBOARD) or (n.get("identifier") or "") in STATUS_BAR_IDS:
            return
        f = n.get("frame") or {}
        has = f.get("Width", 0) > 0 and f.get("Height", 0) > 0
        e = None
        if has:
            text = " | ".join(t for t in (n.get("label"), n.get("title"), n.get("value")) if t)
            e = {"type": et, "label": n.get("label") or "", "text": text,
                 "identifier": n.get("identifier") or "",
                 "x": f["X"], "y": f["Y"], "w": f["Width"], "h": f["Height"],
                 "ancestors": ancestors, "uid": len(out)}
            out.append(e)
        for c in n.get("children") or []:
            walk(c, ancestors + [e] if e else ancestors)

    walk(root, [])
    return out


def size_class(root):
    rh, rv = root.get("horizontalSizeClass"), root.get("verticalSizeClass")
    if rh and rv:
        return rh, rv, "root"
    stack = [root]
    while stack:
        n = stack.pop(0)
        if n.get("horizontalSizeClass") and n.get("verticalSizeClass"):
            return n["horizontalSizeClass"], n["verticalSizeClass"], f"first descendant (root {rh}x{rv})"
        stack.extend(n.get("children") or [])
    return rh or 0, rv or 0, "root"


def same_frame(a, b):
    return all(abs(a[k] - b[k]) <= TOL for k in ("x", "y", "w", "h"))


def contains(a, b):
    return (a["x"] <= b["x"] + TOL and a["y"] <= b["y"] + TOL and
            a["x"] + a["w"] >= b["x"] + b["w"] - TOL and a["y"] + a["h"] >= b["y"] + b["h"] - TOL)


def inter(a, b):
    w = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    h = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    return max(0, w) * max(0, h)


def in_scroller(e):
    return any(a["type"] in SCROLLERS for a in e["ancestors"])


def container(e):
    """Nearest ancestor with a frame different from the element's own (application/window excluded)."""
    for a in reversed(e["ancestors"]):
        if a["type"] in (APPLICATION, WINDOW):
            return None
        if not same_frame(a, e):
            return a
    return None


def name(e):
    return (e["text"] or e["identifier"] or "(no label)").replace("\n", " ")[:60]


def where(e):
    return f'({round(e["x"])},{round(e["y"])} {round(e["w"])}x{round(e["h"])})'


TRUNC_RE = re.compile(r"(…|\.\.\.)")
HYPHEN_RE = re.compile(r"[^\W\d_]-(\s*\n|\s*$)")


def analyse(root, safe=None, edge=16.0, overlap=0.2):
    scr = screen_frame(root)
    W, H = scr.get("Width", 0), scr.get("Height", 0)
    sx, sy = scr.get("X", 0), scr.get("Y", 0)
    landscape = W > H
    if safe is None:
        safe = (0, 21, 59, 59) if landscape else (59, 34, 0, 0)
    T, B, L, R = safe
    els = [e for e in collect(root) if e["type"] in CHECKED and (e["text"] or e["identifier"])]
    # de-duplicate identical text + frame (driver repeats some elements)
    seen, uniq = set(), []
    for e in els:
        k = (e["type"], e["text"], round(e["x"]), round(e["y"]), round(e["w"]), round(e["h"]))
        if k not in seen:
            seen.add(k)
            uniq.append(e)
    els = uniq

    def centre_in(e):
        cx, cy = e["x"] + e["w"] / 2, e["y"] + e["h"] / 2
        return sx <= cx <= sx + W and sy <= cy <= sy + H

    def touches(e):
        return e["x"] < sx + W and e["x"] + e["w"] > sx and e["y"] < sy + H and e["y"] + e["h"] > sy

    vis = [e for e in els if centre_in(e)]
    hits = {k: [] for k in CHECKS}
    offscreen = sum(1 for e in els if not touches(e))

    def add(check, e, detail):
        hits[check].append((e, detail))

    for e in els:
        if not touches(e):
            continue
        cut = []
        if e["x"] < sx - TOL:
            cut.append(f"left {round(e['x'] - sx)}")
        if e["x"] + e["w"] > sx + W + TOL:
            cut.append(f"right +{round(e['x'] + e['w'] - sx - W)}")
        if not in_scroller(e):
            if e["y"] < sy - TOL:
                cut.append(f"top {round(e['y'] - sy)}")
            if e["y"] + e["h"] > sy + H + TOL:
                cut.append(f"bottom +{round(e['y'] + e['h'] - sy - H)}")
        if cut:
            add("clipped_screen", e, "cut " + ", ".join(cut) + " pt")
        c = container(e)
        if c and c["type"] not in SCROLLERS:
            out = []
            for side, d in (("left", c["x"] - e["x"]), ("top", c["y"] - e["y"]),
                            ("right", e["x"] + e["w"] - c["x"] - c["w"]),
                            ("bottom", e["y"] + e["h"] - c["y"] - c["h"])):
                if d > TOL:
                    out.append(f"{side} +{round(d)}")
            if out:
                add("clipped_parent", e, f"outside t{c['type']} {name(c)!r} {where(c)}: " + ", ".join(out) + " pt")

    for e in vis:
        zones = []
        if T and e["y"] < sy + T:
            zones.append(f"top inset {T}")
        if B and e["type"] in INTERACTIVE and e["y"] + e["h"] > sy + H - B:
            zones.append(f"bottom inset {B}")
        if L and e["x"] < sx + L:
            zones.append(f"left inset {L}")
        if R and e["x"] + e["w"] > sx + W - R:
            zones.append(f"right inset {R}")
        if zones:
            add("unsafe", e, ", ".join(zones) + (" (in scroll view: may just be scrolled under a bar)"
                                                  if in_scroller(e) else ""))
        for t in (e["label"], e["text"]):
            if t and (TRUNC_RE.search(t) or HYPHEN_RE.search(t)):
                add("truncated", e, "ellipsis" if TRUNC_RE.search(t) else "word split by hyphen at line end")
                break
        if e["type"] == 9 and e["w"] >= W - edge:
            add("full_width", e, f"side padding {round(e['x'] - sx)} / {round(sx + W - e['x'] - e['w'])} pt")

    texts = [e for e in vis if e["type"] in TEXT and e["text"]]
    for i, a in enumerate(texts):
        for b in texts[i + 1:]:
            if a["text"] == b["text"] or contains(a, b) or contains(b, a):
                continue
            if a["uid"] in {x["uid"] for x in b["ancestors"]} or b["uid"] in {x["uid"] for x in a["ancestors"]}:
                continue
            area = inter(a, b)
            if area > overlap * min(a["w"] * a["h"], b["w"] * b["h"]):
                add("overlap", a, f"overlaps {name(b)!r} {where(b)} by {round(area)} pt²")

    h, v, src = size_class(root)
    meta = {"W": W, "H": H, "landscape": landscape, "safe": safe, "sc": (h, v, src),
            "offscreen": offscreen, "visible": vis}
    return hits, meta


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--screen", default="screen", help="name for this screen in the output")
    ap.add_argument("--hierarchy", help="check a saved viewHierarchy JSON instead of the live screen")
    ap.add_argument("--tsv", help="append findings to this TSV (header written when new)")
    ap.add_argument("--shot", help="also save <DIR>/<screen>.png and .json (live only)")
    ap.add_argument("--texts", action="store_true", help="also list every visible text")
    ap.add_argument("--app", default=os.environ.get("IOS_APP_ID"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("IOS_DRIVER_PORT", "22087")))
    ap.add_argument("--safe", help="safe-area insets T,B,L,R in pt")
    ap.add_argument("--edge", type=float, default=16.0, help="full_width: total side padding below this")
    ap.add_argument("--overlap", type=float, default=0.2, help="overlap: fraction of the smaller frame")
    a = ap.parse_args(argv)
    safe = None
    if a.safe:
        try:
            safe = tuple(float(v) for v in a.safe.split(","))
            assert len(safe) == 4
        except (ValueError, AssertionError):
            ap.error("--safe takes four numbers: T,B,L,R")
    try:
        if a.hierarchy:
            with open(a.hierarchy) as fh:
                h = json.load(fh)
        else:
            d = Driver(port=a.port, app_id=a.app)
            h = d.view_hierarchy()
            if a.shot:
                os.makedirs(a.shot, exist_ok=True)
                with open(os.path.join(a.shot, f"{a.screen}.png"), "wb") as fh:
                    fh.write(d.screenshot())
                with open(os.path.join(a.shot, f"{a.screen}.json"), "w") as fh:
                    json.dump(h, fh)
    except DriverError as e:
        print(f"layout_walk: {e}", file=sys.stderr)
        return 2
    root = h.get("axElement", h)
    hits, m = analyse(root, safe, a.edge, a.overlap)
    sh, sv, src = m["sc"]
    print(f"# {a.screen}: {m['W']:.0f}x{m['H']:.0f} pt {'landscape' if m['landscape'] else 'portrait'}, "
          f"size class {SC_NAMES.get(sh, sh)} x {SC_NAMES.get(sv, sv)} ({sh}x{sv}, {src}), "
          f"safe T,B,L,R {','.join(f'{v:g}' for v in m['safe'])}")
    for k in CHECKS:
        if not hits[k]:
            continue
        print(f"{k} ({len(hits[k])})")
        for e, detail in hits[k]:
            print(f"  t{e['type']:<3} {name(e)!r} {where(e)} {e['identifier']}  — {detail}")
    if m["offscreen"]:
        print(f"off-screen: {m['offscreen']} element(s) entirely outside the screen (paged copies, "
              f"scroll content or stale frames — not checked)")
    if a.texts:
        print("texts:")
        for t in dict.fromkeys(e["text"] for e in m["visible"] if e["text"]):
            print(f"  {t!r}")
    flags = {k: len(v) for k, v in hits.items() if v}
    print(f"{a.screen}: {flags or 'no layout flags'} — tree-based; confirm clipped/off-screen on the screenshot")
    if a.tsv:
        new = not os.path.exists(a.tsv) or os.path.getsize(a.tsv) == 0
        with open(a.tsv, "a") as fh:
            if new:
                fh.write("\t".join(COLUMNS) + "\n")
            fh.write("\t".join([a.screen, "size_class", "", "", "", "", "", "", "",
                                f"{SC_NAMES.get(sh, sh)}x{SC_NAMES.get(sv, sv)} ({src})"]) + "\n")
            for k in CHECKS:
                for e, detail in hits[k]:
                    row = [a.screen, k, TEXT.get(e["type"], f"t{e['type']}"), name(e), e["identifier"],
                           round(e["x"]), round(e["y"]), round(e["w"]), round(e["h"]), detail]
                    fh.write("\t".join(str(c).replace("\t", " ") for c in row) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
