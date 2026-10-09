#!/usr/bin/env python3
"""springboard_watch.py — poll what iOS itself shows outside the app (Dynamic Island, Lock
Screen / Notification Center Live Activities, widgets, notification banners) through the
XCUITest driver with app_id com.apple.springboard, and log every change with a timestamp.
A timed log catches short gaps and back-steps that screenshot pairs miss (an ETA going up
again, a Live Activity frozen while the app moves on, a widget that never refreshes).

qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.

Prerequisites: the driver running and forwarded (ios-device-testing: scripts/driver/up.sh)
and its ios_driver.py importable: next to this file, in ../../ios-device-testing/scripts/driver
(plugin layout), in ./scripts/driver, or in $IOS_DRIVER_DIR. Phone unlocked unless you are
watching the Lock Screen on purpose (the hierarchy still reads; USB capture does not).
Usage:
  springboard_watch.py [--every 20] [--minutes 30 | --until HH:MM[:SS]]
                       [--surface island,lockscreen,widgets,notifications,other,icons]
                       [--match REGEX] [--ignore REGEX] [--app BUNDLE_ID]
                       [--log FILE] [--shots DIR] [--shot-every N] [--stop-on-change]
  --match RE      keep only texts matching (e.g. the app's name or the activity's wording)
  --ignore RE     drop texts matching, on top of the built-in noise filter (clock, battery…)
  --app ID        also log that app's visible texts (matching --match) at the same instant —
                  only meaningful while the app is in front
  --shots DIR     screenshot on every change, and every N polls with --shot-every
  --stop-on-change  exit 0 at the first change (e.g. "tell me when the widget updates")
  springboard_watch.py --dump saved.json   classify a saved SpringBoard hierarchy, no driver
Options: --port (env IOS_DRIVER_PORT, 22087). Output goes to stdout and, with --log, a file.
Surfaces are recognised by structure (status bar subtree dropped; identifiers jindo-* /
SystemAperture = island, SBCoverSheetWindow = Lock Screen, *Widget* = widget,
ShortLook/ListCell = notification, an icon labelled "Widget" = widget; other home-screen
icons = "icons", off by default) — SpringBoard internals change between iOS versions, so
check `--dump` once on a new iOS and use --match when a surface lands in "other".
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.environ.get("IOS_DRIVER_DIR"), HERE, os.path.join(HERE, "driver"),
           os.path.join(HERE, "..", "..", "ios-device-testing", "scripts", "driver"),
           os.path.join(os.getcwd(), "scripts", "driver")):
    if _p and os.path.exists(os.path.join(_p, "ios_driver.py")):
        sys.path.insert(0, _p)
        break
try:
    from ios_driver import Driver, DriverError, screen_frame, visible  # noqa: E402
except ImportError:
    sys.exit("springboard_watch: ios_driver.py not found — copy it next to this file or set IOS_DRIVER_DIR")

SPRINGBOARD = "com.apple.springboard"
STATUS_BAR = 25
SURFACES = ("island", "lockscreen", "widgets", "notifications", "other", "icons")
DEFAULT_SURFACES = SURFACES[:-1]  # home-screen icons (badges) only on request
ICON = 44
# (surface, identifier regex) — the innermost match wins, so a widget on the Lock Screen is "widgets".
RULES = [
    ("island", re.compile(r"^jindo|SystemAperture|DynamicIsland", re.I)),
    ("lockscreen", re.compile(r"^SBCoverSheetWindow$|^combined-list-view$", re.I)),
    ("widgets", re.compile(r"widget", re.I)),
    ("notifications", re.compile(r"^NotificationShortLookView$|^ShortLook\.|^ListCell$|^BannerWindow", re.I)),
]
SKIP_IDS = re.compile(r"^lockscreen-date-view$")  # the big Lock Screen clock + date: changes every minute
NOISE = re.compile(r"battery|Wi-Fi|Mobile Service|SSID|signal bars|scroll bar|^Home indicator$|^Page \d+ of \d+"
                   r"|^Clock \| \d|^Search( \|.*)?$|^Dock$", re.I)


def classify(root, ignore=None, match=None):
    """{surface: [texts in tree order, unique]} for the on-screen part of a SpringBoard tree."""
    scr = screen_frame(root)
    W, H = scr.get("Width") or 0, scr.get("Height") or 0
    out = {s: [] for s in SURFACES}

    def on_screen(f):
        if not (W and H and f.get("Width", 0) > 0 and f.get("Height", 0) > 0):
            return True  # unknown or zero-size containers: look inside
        cx, cy = f["X"] + f["Width"] / 2, f["Y"] + f["Height"] / 2
        return 0 <= cx <= W and 0 <= cy <= H

    def walk(n, surface):
        if n.get("elementType") == STATUS_BAR:
            return
        ident = n.get("identifier") or ""
        if SKIP_IDS.search(ident):
            return
        f = n.get("frame") or {}
        if not on_screen(f):
            return
        for s, rx in RULES:
            if ident and rx.search(ident):
                surface = s
                break
        text = " | ".join(t for t in (n.get("label"), n.get("title"), n.get("value")) if t and t.strip())
        if n.get("elementType") == ICON:  # a widget is an icon whose label says so
            surface = "widgets" if re.search(r"\bWidget\b", text) else "icons"
        if text and f.get("Width", 0) > 0 and f.get("Height", 0) > 0 and not NOISE.search(text) \
                and not (ignore and ignore.search(text)) and (not match or match.search(text)):
            if text not in out[surface]:
                out[surface].append(text)
        for c in n.get("children") or []:
            walk(c, surface)

    walk(root, "other")
    return out


def diff(prev, cur):
    """Lines describing what changed per surface (empty list = no change)."""
    lines = []
    for s in cur:
        a, b = prev.get(s, []), cur[s]
        if a == b:
            continue
        added = [t for t in b if t not in a]
        removed = [t for t in a if t not in b]
        parts = [f"+{t!r}" for t in added] + [f"-{t!r}" for t in removed]
        lines.append(f"{s}: " + (" ".join(parts) if parts else "reordered " + repr(b)))
    return lines


def app_texts(driver, match):
    els, scr = driver.elements()
    return list(dict.fromkeys(e["text"][:100] for e in visible(els, scr)
                              if e["text"] and (not match or match.search(e["text"]))))


def parse_until(s):
    now = dt.datetime.now()
    t = dt.datetime.strptime(s, "%H:%M:%S" if s.count(":") == 2 else "%H:%M").time()
    end = dt.datetime.combine(now.date(), t)
    return (end if end > now else end + dt.timedelta(days=1)).timestamp()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--every", type=float, default=20.0, help="seconds between polls (default 20)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--minutes", type=float, default=30.0)
    g.add_argument("--until", help="local time HH:MM[:SS]")
    ap.add_argument("--surface", default=",".join(DEFAULT_SURFACES),
                    help=f"comma-separated, from {','.join(SURFACES)} (default: all but icons)")
    ap.add_argument("--match")
    ap.add_argument("--ignore")
    ap.add_argument("--app", help="also log this app's visible texts")
    ap.add_argument("--log")
    ap.add_argument("--shots")
    ap.add_argument("--shot-every", type=int, default=0)
    ap.add_argument("--stop-on-change", action="store_true")
    ap.add_argument("--dump", help="classify a saved hierarchy JSON and exit")
    ap.add_argument("--port", type=int, default=int(os.environ.get("IOS_DRIVER_PORT", "22087")))
    ap.add_argument("--timeout", type=float, default=60.0, help="seconds per driver call (default 60)")
    a = ap.parse_args(argv)
    wanted = [s for s in a.surface.split(",") if s]
    if any(s not in SURFACES for s in wanted):
        ap.error(f"--surface: choose from {','.join(SURFACES)}")
    match = re.compile(a.match, re.I) if a.match else None
    ignore = re.compile(a.ignore, re.I) if a.ignore else None

    if a.dump:
        with open(a.dump) as fh:
            h = json.load(fh)
        res = classify(h.get("axElement", h), ignore, match)
        for s in wanted:
            print(f"{s}: {res[s]}")
        return 0

    sb = Driver(port=a.port, app_id=SPRINGBOARD, timeout=a.timeout)
    app = Driver(port=a.port, app_id=a.app, timeout=a.timeout) if a.app else None
    log = open(a.log, "a", buffering=1) if a.log else None
    if a.shots:
        os.makedirs(a.shots, exist_ok=True)

    def emit(line):
        print(line, flush=True)
        if log:
            log.write(line + "\n")

    def shot(ts, why):
        if not a.shots:
            return
        try:
            path = os.path.join(a.shots, f"sb-{ts.replace(':', '')}-{why}.png")
            with open(path, "wb") as fh:
                fh.write(sb.screenshot())
        except (DriverError, OSError) as e:
            emit(f"{ts} screenshot failed: {e}")

    end = parse_until(a.until) if a.until else time.time() + a.minutes * 60
    prev, n = None, 0
    emit(f"{time.strftime('%H:%M:%S')} watching {','.join(wanted)} every {a.every:g}s until "
         f"{time.strftime('%H:%M:%S', time.localtime(end))}")
    try:
        while time.time() < end:
            ts = time.strftime("%H:%M:%S")
            try:
                h = sb.view_hierarchy()
                res = classify(h.get("axElement", h), ignore, match)
                cur = {s: res[s] for s in wanted}
                if app:
                    cur["app"] = app_texts(app, match)
                if prev is None:
                    emit(f"{ts} start " + " ".join(f"{s}={v!r}" for s, v in cur.items()))
                    shot(ts, "start")
                else:
                    changes = diff(prev, cur)
                    for line in changes:
                        emit(f"{ts} {line}")
                    if changes:
                        shot(ts, "change")
                        if a.stop_on_change:
                            return 0
                    elif a.shot_every and n % a.shot_every == 0:
                        shot(ts, "poll")
                prev = cur
            except DriverError as e:
                emit(f"{ts} driver error: {e}")
            n += 1
            time.sleep(max(0.0, min(a.every, end - time.time())))
    except KeyboardInterrupt:
        pass
    emit(f"{time.strftime('%H:%M:%S')} watch ended")
    return 0


if __name__ == "__main__":
    sys.exit(main())
