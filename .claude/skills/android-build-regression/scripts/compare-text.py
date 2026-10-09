#!/usr/bin/env python3
"""compare-text.py - compare the on-screen text of two builds as sets (CMS trap).

What: when the two builds are served different CMS content, a pixel diff on a
  content-heavy screen says "different" without saying whether anything is
  MISSING. Comparing the set of visible strings does, because the asymmetry
  carries the meaning:
    string in reference, not in candidate  -> signal, investigate
    string only in candidate               -> usually newer CMS content
  With --apk / --pool, every missing string is cross-checked against the APK
  string pool: found there = a string RESOURCE (a real lead), not found =
  backend CONTENT (menus, names, hours - tests the API, not the ticket).
  Format strings in the pool ("Hi, %s") match their rendered form ("Hi, Sam");
  matching is case-insensitive because textAllCaps renders "Order now" as
  "ORDER NOW".

Input dumps (per screen, one file each; a directory pairs files by name):
  *.txt   one string per line (e.g. written by --capture)
  *.xml   `adb exec-out uiautomator dump /dev/tty`
  *.json  `maestro hierarchy` output
  Device chrome (system UI, keyboards) is dropped; see NOISE.

Prerequisites: python3 (stdlib only). aapt2 for --apk (found via find-tools.sh
  locations); adb and a device only for --capture.

Usage:
  compare-text.py <ref.txt|ref-dir> <cand.txt|cand-dir> [--apk REF.apk]... [--pool strings.txt|snapshot-dir]...
                  [--cand-apk CAND.apk] [--cand-pool ...] [--json out.json] [--limit N]
  compare-text.py --capture out.txt [--app <appId>] [--scrolls N]
      dump the current screen's text, scrolling down until nothing new appears
      (the whole scroll extent, so a layout shift can't push a string off-screen
      and fake a "missing"). With --app, refuses to swipe unless <appId> is in
      front, and keeps only that app's nodes.

Exit: 0 nothing missing (or only content), 1 a missing string that is a
  resource or could not be classified, 2 usage error.
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

# resource-id / package fragments of device chrome, never the app under test
NOISE = ("com.android.systemui", "inputmethod", "honeyboard", "com.samsung.android.",
         "com.google.android.inputmethod", "android:id/statusBarBackground",
         "android:id/navigationBarBackground")


# ---------------------------------------------------------------- tools ---
def find_tool(name):
    if shutil.which(name):
        return shutil.which(name)
    sdks = [os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"),
            str(Path.home() / "Library/Android/sdk"), str(Path.home() / "Android/Sdk")]
    for sdk in filter(None, sdks):
        if name == "adb" and os.access(f"{sdk}/platform-tools/adb", os.X_OK):
            return f"{sdk}/platform-tools/adb"
        if name == "aapt2":
            hits = sorted(glob.glob(f"{sdk}/build-tools/*/aapt2"),
                          key=lambda p: [int(x) if x.isdigit() else x
                                         for x in re.split(r"[.\-]", Path(p).parent.name)])
            if hits:
                return hits[-1]
    sys.exit(f"compare-text: {name} not found on PATH or in the Android SDK (set ANDROID_HOME)")


# -------------------------------------------------------------- parsing ---
def keep(s):
    s = " ".join(s.replace(" ", " ").split())
    if len(s) < 2 or re.fullmatch(r"[\d\s:.,%/+\-]+", s):  # clocks, counters, percentages
        return None
    return s


def is_noise(ident):
    return any(n in (ident or "") for n in NOISE)


def from_uiautomator(text, app=None):
    xml = text[text.find("<?xml"):text.rfind(">") + 1] if "<?xml" in text else text
    out = set()
    for n in ET.fromstring(xml).iter("node"):
        if is_noise(n.get("resource-id")) or is_noise(n.get("package")):
            continue
        if app and n.get("package") and n.get("package") != app:
            continue
        for k in ("text", "content-desc"):
            v = keep(n.get(k) or "")
            if v:
                out.add(v)
    return out


def from_maestro(text):
    tree = json.loads(text[text.find("{"):])
    out = set()

    def walk(n, noisy=False):
        if not isinstance(n, dict):
            return
        a = n.get("attributes") or {}
        # inherited: keyboard labels hang off children with empty resource-ids
        noisy = noisy or is_noise(a.get("resource-id"))
        if not noisy:
            for k in ("text", "accessibilityText", "hintText"):
                v = keep(a.get(k) or "")
                if v:
                    out.add(v)
        for c in n.get("children") or []:
            walk(c, noisy)

    walk(tree)
    return out


def load_dump(path):
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    head = text.lstrip()[:200]
    if path.endswith(".xml") or "<hierarchy" in head or head.startswith("<?xml"):
        return from_uiautomator(text)
    if path.endswith(".json"):
        return from_maestro(text)
    return {v for v in (keep(line) for line in text.splitlines()) if v}


def pair_inputs(ref, cand):
    """[(screen, ref_file|None, cand_file|None)]"""
    if os.path.isfile(ref) and os.path.isfile(cand):
        return [(Path(ref).stem, ref, cand)]
    if os.path.isdir(ref) and os.path.isdir(cand):
        def index(d):
            return {p.stem: str(p) for p in sorted(Path(d).iterdir())
                    if p.is_file() and p.suffix in (".txt", ".xml", ".json")}
        r, c = index(ref), index(cand)
        return [(s, r.get(s), c.get(s)) for s in sorted(set(r) | set(c))]
    sys.exit("compare-text: give two files or two directories")


# ---------------------------------------------------------- string pool ---
def load_pool(paths, apks):
    pool = set()
    for p in paths or []:
        f = Path(p) / "strings.txt" if os.path.isdir(p) else Path(p)
        pool |= {line.strip() for line in f.read_text(encoding="utf-8", errors="replace").splitlines()}
    if apks:
        aapt2 = find_tool("aapt2")
        for apk in apks:
            out = subprocess.run([aapt2, "dump", "strings", apk], capture_output=True,
                                 text=True, errors="replace").stdout
            pool |= {m.group(1).strip() for m in re.finditer(r"^String #\d+ : (.*)$", out, re.M)}
    pool.discard("")
    return pool


FMT = re.compile(r"%(?:\d+\$)?[-#+ 0,(]*\d*(?:\.\d+)?[sdfxXoeEgGc]")


class Pool:
    def __init__(self, strings):
        self.exact = {s.casefold(): s for s in strings}
        self.formats = []
        for s in strings:
            if "%" in s and FMT.search(s):
                parts = FMT.split(s.replace("%%", "\0"))
                if sum(len(p.strip()) for p in parts) >= 3:  # "%s" alone matches anything
                    rx = ".+?".join(re.escape(p).replace("\0", "%") for p in parts)
                    self.formats.append((s, re.compile(rx, re.I | re.S)))

    def __bool__(self):
        return bool(self.exact)

    def lookup(self, s):
        """None, or the pool string that renders as s"""
        if s.casefold() in self.exact:
            return self.exact[s.casefold()]
        for src, rx in self.formats:
            if rx.fullmatch(s):
                return src
        return None


# -------------------------------------------------------------- capture ---
def capture(out_path, app, scrolls):
    adb = find_tool("adb")

    def sh(*a):
        return subprocess.run([adb, *a], capture_output=True, text=True, errors="replace").stdout

    def in_front():
        line = next((l for l in sh("shell", "dumpsys", "activity", "activities").splitlines()
                     if "topResumedActivity" in l or "mResumedActivity" in l), "")
        return app in line

    def dump():
        for _ in range(3):
            raw = sh("exec-out", "uiautomator", "dump", "/dev/tty")
            if "<?xml" in raw:
                return from_uiautomator(raw, app)
            time.sleep(1)
        sys.exit("compare-text: uiautomator dump returned nothing (screen off? animation running?)")

    sizes = re.findall(r"(\d+)x(\d+)", sh("shell", "wm", "size"))  # override size, if any, is last
    w, h = map(int, sizes[-1]) if sizes else (1080, 2400)
    seen = dump()
    for _ in range(scrolls):
        if app and not in_front():
            print(f"stopped scrolling: {app} is not in front", file=sys.stderr)
            break
        before = len(seen)
        sh("shell", "input", "swipe", str(w // 2), str(int(h * 0.75)), str(w // 2), str(int(h * 0.35)), "300")
        time.sleep(0.8)
        seen |= dump()
        if len(seen) == before:  # nothing new: bottom reached
            break
    Path(out_path).write_text("\n".join(sorted(seen)) + "\n", encoding="utf-8")
    print(f"{len(seen)} strings -> {out_path}")
    return 0


# -------------------------------------------------------------- compare ---
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="\n".join(__doc__.split("\n")[1:]))
    ap.add_argument("ref", nargs="?")
    ap.add_argument("cand", nargs="?")
    ap.add_argument("--apk", action="append", help="reference APK; its string pool classifies misses")
    ap.add_argument("--pool", action="append", help="strings.txt or snapshot dir (snapshot-resources.sh)")
    ap.add_argument("--cand-apk", action="append")
    ap.add_argument("--cand-pool", action="append")
    ap.add_argument("--json")
    ap.add_argument("--limit", type=int, default=15)
    ap.add_argument("--capture", metavar="OUT")
    ap.add_argument("--app")
    ap.add_argument("--scrolls", type=int, default=6)
    a = ap.parse_args()

    if a.capture:
        return capture(a.capture, a.app, a.scrolls)
    if not (a.ref and a.cand):
        ap.print_usage(sys.stderr)
        return 2

    ref_pool = Pool(load_pool(a.pool, a.apk))
    cand_pool = Pool(load_pool(a.cand_pool, a.cand_apk))

    def classify(s):
        src = ref_pool.lookup(s) if ref_pool else None
        if not ref_pool:
            return "unclassified", None
        if src is None:
            return "content", None
        if cand_pool:
            return ("resource, still in candidate APK" if cand_pool.lookup(s)
                    else "resource, GONE from candidate APK"), src
        return "resource", src

    print("=" * 78)
    print(" text-set comparison   reference vs candidate")
    if ref_pool:
        print(f"   string pool: {len(ref_pool.exact)} reference strings"
              + (f", {len(cand_pool.exact)} candidate" if cand_pool else ""))
    print("=" * 78)
    print(f"{'screen':<28} {'missing':>8} {'extra':>7}   verdict")
    print("-" * 78)

    report, details, bad = {}, [], False
    for screen, rf, cf in pair_inputs(a.ref, a.cand):
        if not rf or not cf:
            print(f"{screen:<28} {'-':>8} {'-':>7}   only in {'reference' if rf else 'candidate'} dir")
            report[screen] = {"error": "unpaired"}
            continue
        r, c = load_dump(rf), load_dump(cf)
        missing, extra = sorted(r - c), sorted(c - r)
        cls = {m: classify(m) for m in missing}
        leads = [m for m in missing if cls[m][0] != "content"]
        if leads:
            verdict, bad = "MISSING - investigate", True
        elif missing:
            verdict = "missing content only"
        elif extra:
            verdict = "extra only (new content?)"
        else:
            verdict = "identical"
        print(f"{screen:<28} {len(missing):>8} {len(extra):>7}   {verdict}")
        report[screen] = {"missing": [{"text": m, "class": cls[m][0], "pool": cls[m][1]} for m in missing],
                          "extra": extra}
        if missing or extra:
            details.append((screen, missing, extra, cls))
    print("-" * 78)

    for screen, missing, extra, cls in details:
        print(f"\n{screen}")
        for m in missing[:a.limit]:
            kind, src = cls[m]
            via = f"  (pool: {src!r})" if src and src != m else ""
            print(f"  - only in reference  [{kind}] {m!r}{via}")
        if len(missing) > a.limit:
            print(f"    ... {len(missing) - a.limit} more missing")
        for e in extra[:a.limit]:
            print(f"  + only in candidate  {e!r}")
        if len(extra) > a.limit:
            print(f"    ... {len(extra) - a.limit} more extra")

    if not ref_pool and any(d[1] for d in details):
        print("\nnote: no --apk/--pool given, so missing strings are unclassified;"
              " cross-check them against the reference APK's string pool.")
    if a.json:
        Path(a.json).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\ndetail: {a.json}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
