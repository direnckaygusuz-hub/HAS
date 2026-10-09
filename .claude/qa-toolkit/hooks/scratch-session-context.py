#!/usr/bin/env python3
"""SessionStart: when the session starts in a scratch folder, tell Claude to move to the
client's project folder first, and name the projects it can see. Prints nothing
otherwise. Any internal error -> exit 0.

The projects come from the plugin setting clients_dir (env CLAUDE_PLUGIN_OPTION_CLIENTS_DIR,
default ~/Documents/Claude): its sub-folders that have a CLAUDE.md, at most 12.
"""
import json
import os
import sys

BASE = (
    "This session runs in a scratch folder: for client QA work, run /qa-project (or open the "
    "client's project folder) first, so its CLAUDE.md, context file, scripts and saved "
    "sessions are used and kept."
)


def projects():
    root = os.path.expanduser(os.environ.get("CLAUDE_PLUGIN_OPTION_CLIENTS_DIR") or "~/Documents/Claude")
    try:
        names = sorted(n for n in os.listdir(root)
                       if os.path.isfile(os.path.join(root, n, "CLAUDE.md")))
    except OSError:
        return root, []
    return root, names[:12]


def main():
    data = json.loads(sys.stdin.read() or "{}")
    cwd = data.get("cwd") if isinstance(data, dict) else None
    if not (isinstance(cwd, str) and ("scratch-workspaces" in cwd or "/scratchpad" in cwd)):
        return 0
    context = BASE
    root, names = projects()
    if names:
        context += " Projects with a CLAUDE.md in %s: %s." % (root, ", ".join(names))
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart", "additionalContext": context}}))
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception:
        code = 0
    sys.exit(code)
