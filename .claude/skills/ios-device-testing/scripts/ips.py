#!/usr/bin/env python3
"""ips.py — summarise iOS crash reports (.ips, bug_type 309): the header (app, build,
bundle ID, OS), exception and termination, the faulting thread's frames, the last
exception backtrace, and the app image's UUID for symbolication. Given several reports,
it also says whether their faulting stacks are identical (= a deterministic crash).

qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.

Prerequisites: Python 3 standard library only. Pull reports with
  xcrun devicectl device copy from --device <id> --domain-type systemCrashLogs \\
      --source "Retired/<Executable>-<date>.ips" --destination ./crash.ips
Usage:  ips.py <file.ips> [more.ips ...] [--frames 30]
Frames in the app's own image are marked "*"; an unsymbolicated build shows only offsets —
pass those and the UUID to the developers to symbolicate with the dSYM.
"""
import argparse
import json
import sys

HEADER_KEYS = ("app_name", "app_version", "build_version", "bundleID", "os_version", "timestamp",
               "incident_id", "bug_type")


def load(path):
    """(header, body) — body is None when the report isn't a JSON crash report."""
    with open(path, encoding="utf-8", errors="replace") as f:
        first, _, rest = f.read().partition("\n")
    header = json.loads(first)
    try:
        body = json.loads(rest) if rest.strip() else None
    except json.JSONDecodeError:
        body = None
    return header, body


def frames_of(body, frames, n):
    imgs = body.get("usedImages") or []
    app = body.get("procName")
    out = []
    for f in frames[:n]:
        idx = f.get("imageIndex")
        im = imgs[idx] if isinstance(idx, int) and 0 <= idx < len(imgs) else {}
        name = im.get("name", "?")
        sym = f.get("symbol", "")
        if sym and f.get("symbolLocation") is not None:
            sym += f" + {f['symbolLocation']}"
        out.append({"image": name, "offset": f.get("imageOffset", 0), "symbol": sym, "app": name == app})
    return out


def faulting(body, n):
    threads = body.get("threads") or []
    ft = body.get("faultingThread")
    if not isinstance(ft, int) or not (0 <= ft < len(threads)):
        return None, []
    th = threads[ft]
    return th, frames_of(body, th.get("frames") or [], n)


def print_stack(frames):
    for fr in frames:
        mark = "*" if fr["app"] else " "
        print(f"  {mark} {fr['image']:34} +0x{fr['offset']:x}  {fr['symbol']}")


def summarise(path, n):
    header, body = load(path)
    print(f"== {path}")
    print("  " + ", ".join(f"{k}={header[k]}" for k in HEADER_KEYS if header.get(k) not in (None, "")))
    if body is None:
        print(f"  body is not a JSON crash report (bug_type {header.get('bug_type')}) — read it as text")
        return None
    for k in ("exception", "termination", "asi", "ktriageinfo"):
        if body.get(k):
            print(f"  {k}: {json.dumps(body[k], ensure_ascii=False)}")
    app = body.get("procName")
    for im in body.get("usedImages") or []:
        if im.get("name") == app:
            print(f"  app image: {im.get('name')} uuid={im.get('uuid')} base=0x{im.get('base', 0):x} arch={im.get('arch')}")
            break
    th, frames = faulting(body, n)
    if th is not None:
        print(f"  faulting thread {body.get('faultingThread')} name={th.get('name')} queue={th.get('queue')}")
        print_stack(frames)
    leb = body.get("lastExceptionBacktrace")
    if leb:
        print("  lastExceptionBacktrace:")
        print_stack(frames_of(body, leb, n))
    _, full = faulting(body, 10 ** 6)  # compare whole stacks, not just the printed part
    return [(fr["image"], fr["offset"]) for fr in full]


def compare(stacks):
    """stacks: {path: [(image, offset), ...]} -> one-line verdict."""
    items = [(p, s) for p, s in stacks.items() if s]
    if len(items) < 2:
        return None
    ref_path, ref = items[0]
    for p, s in items[1:]:
        if s != ref:
            i = next((k for k, (a, b) in enumerate(zip(ref, s)) if a != b), min(len(ref), len(s)))
            return f"faulting stacks DIFFER: {ref_path} vs {p} from frame {i}"
    return f"faulting stacks identical across {len(items)} reports (deterministic crash)"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--frames", type=int, default=30, help="frames per stack (default 30)")
    a = ap.parse_args(argv)
    stacks, rc = {}, 0
    for p in a.files:
        try:
            stacks[p] = summarise(p, a.frames)
        except (OSError, ValueError) as e:
            print(f"== {p}\n  ERR {e}")
            rc = 1
    verdict = compare(stacks)
    if verdict:
        print(verdict)
    return rc


if __name__ == "__main__":
    sys.exit(main())
