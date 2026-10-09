#!/usr/bin/env python3
"""enum-clickable.py - list every tappable element on the current screen, and how
it can be selected (layer 2: writing flows, and the "missing accessibility IDs"
finding).

What: selectors must come from the real view hierarchy - reading labels off a
  screenshot invents strings that don't exist. Compose nests a clickable
  container around a child Text, so for each clickable node this collects the
  labels beneath it and any resource-id (a Compose testTag shows up as one only
  with testTagsAsResourceId). Each control is reported as:
    ID    has a resource-id              -> stable selector (id:)
    TEXT  label only, no resource-id     -> breaks on copy/translation: a finding
    NONE  no label, no id                -> only index/coordinates: a finding
  The TEXT and NONE rows are what to hand the developers as "please add a
  resource-id / contentDescription".

Prerequisites: python3 (stdlib). For a live screen: adb and a device (default,
  uiautomator dump - no Maestro needed), or maestro with --maestro. Reading a
  saved dump needs neither.

Usage:
  enum-clickable.py                      # live screen via adb uiautomator
  enum-clickable.py --app <appId>        # only nodes of that package
  enum-clickable.py --maestro            # live screen via `maestro hierarchy`
  enum-clickable.py dump.xml|dump.json   # a saved uiautomator XML or maestro JSON
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

NOISE = ("com.android.systemui", "inputmethod", "honeyboard", "com.google.android.inputmethod")


def adb_path():
    for c in (shutil.which("adb"),
              os.environ.get("ANDROID_HOME") and f"{os.environ['ANDROID_HOME']}/platform-tools/adb",
              str(Path.home() / "Library/Android/sdk/platform-tools/adb"),
              str(Path.home() / "Android/Sdk/platform-tools/adb")):
        if c and os.access(c, os.X_OK):
            return c
    sys.exit("enum-clickable: adb not found (source find-tools.sh or set ANDROID_HOME)")


# normalised node: dict(label list, rid, clickable, bounds, pkg, children)
def norm_xml(el):
    return {"labels": [v for v in (el.get("text"), el.get("content-desc")) if v and v.strip()],
            "rid": el.get("resource-id") or "", "clickable": el.get("clickable") == "true",
            "bounds": el.get("bounds") or "", "pkg": el.get("package") or "",
            "children": [norm_xml(c) for c in el.findall("node")]}


def norm_maestro(n):
    a = (n.get("attributes") or {}) if isinstance(n, dict) else {}
    return {"labels": [a[k] for k in ("text", "accessibilityText", "hintText") if (a.get(k) or "").strip()],
            "rid": a.get("resource-id") or "", "clickable": str(a.get("clickable", "")).lower() == "true",
            "bounds": a.get("bounds") or "", "pkg": "",
            "children": [norm_maestro(c) for c in (n.get("children") or [])] if isinstance(n, dict) else []}


def parse(text):
    if "<hierarchy" in text or "<?xml" in text:
        root = ET.fromstring(text[text.find("<"):text.rfind(">") + 1])
        return {"labels": [], "rid": "", "clickable": False, "bounds": "", "pkg": "",
                "children": [norm_xml(c) for c in root.findall("node")]}
    return norm_maestro(json.loads(text[text.find("{"):]))


def below(n, key, out, depth=0):
    if depth > 8:
        return
    vals = n["labels"] if key == "labels" else ([n["rid"]] if n["rid"] else [])
    out.extend(v.strip() for v in vals if v.strip() not in out)
    for c in n["children"]:
        below(c, key, out, depth + 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("dump", nargs="?", help="saved uiautomator XML or maestro JSON")
    ap.add_argument("--app", help="only nodes whose package is this appId (uiautomator)")
    ap.add_argument("--maestro", action="store_true", help="read the live screen via maestro hierarchy")
    a = ap.parse_args()

    if a.dump:
        text = Path(a.dump).read_text(encoding="utf-8", errors="replace")
    elif a.maestro:
        mae = shutil.which("maestro") or sys.exit("enum-clickable: maestro not on PATH")
        text = subprocess.run([mae, "hierarchy"], capture_output=True, text=True).stdout
    else:
        text = subprocess.run([adb_path(), "exec-out", "uiautomator", "dump", "/dev/tty"],
                              capture_output=True, text=True, errors="replace").stdout
    if "{" not in text and "<" not in text:
        sys.exit("enum-clickable: no hierarchy returned (screen off? device not authorised?)")

    rows, seen = [], set()

    def walk(n, noisy=False):
        noisy = noisy or any(s in n["rid"] or s in n["pkg"] for s in NOISE) \
            or bool(a.app and n["pkg"] and n["pkg"] != a.app)
        if n["clickable"] and not noisy:
            labels, rids = [], []
            below(n, "labels", labels)
            below(n, "rid", rids)
            kind = "ID  " if rids else ("TEXT" if labels else "NONE")
            key = (labels[0] if labels else "", rids[0] if rids else "", "" if labels or rids else n["bounds"])
            if key not in seen:
                seen.add(key)
                label = repr(labels[0]) if labels else "(no label)"
                more = f"  +{len(labels) - 1}: {labels[1:3]}" if len(labels) > 1 else ""
                rid = f"  id={rids[0]}" if rids else ""
                where = f"  bounds={n['bounds']}" if kind != "ID  " and n["bounds"] else ""
                rows.append((kind, f"{kind}  {label}{rid}{more}{where}"))
        for c in n["children"]:
            walk(c, noisy)

    walk(parse(text))
    n = {k: sum(1 for r in rows if r[0] == k) for k in ("ID  ", "TEXT", "NONE")}
    print(f"# {len(rows)} tappables: {n['ID  ']} with resource-id, {n['TEXT']} text-only, {n['NONE']} unlabelled")
    for _, line in sorted(rows, key=lambda r: ("ID  ", "TEXT", "NONE").index(r[0])):
        print(line)
    if n["TEXT"] or n["NONE"]:
        print("# TEXT/NONE rows have no accessibility ID: report them, ask for a resource-id / contentDescription")
    return 0


if __name__ == "__main__":
    sys.exit(main())
