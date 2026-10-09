#!/usr/bin/env python3
"""PostToolUse (Write|Edit|MultiEdit): warn when JS/TS code waits for `networkidle`.

The file is already written; exit 2 puts the note on stderr in front of Claude.
Any internal error -> exit 0.
"""
import json
import sys

JS_TS = (".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx")

NOTE = (
    "Note on {name}: it waits for `networkidle`. networkidle never settles on sites with "
    "analytics beacons, and fires before skeleton loaders resolve. Wait for a real element "
    "(expect(locator).toBeVisible()) or the page's API response (page.waitForResponse) "
    "instead - see the web-environment-matrix skill."
)


def new_text(tool_name, tool_input):
    if tool_name == "Write":
        return tool_input.get("content") or ""
    if tool_name == "Edit":
        return tool_input.get("new_string") or ""
    if tool_name == "MultiEdit":
        edits = tool_input.get("edits") or []
        return "\n".join((e.get("new_string") or "") for e in edits if isinstance(e, dict))
    return ""


def main():
    data = json.loads(sys.stdin.read() or "{}")
    if not isinstance(data, dict):
        return 0
    tool_input = data.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return 0
    path = tool_input.get("file_path") or ""
    if not isinstance(path, str) or not path.lower().endswith(JS_TS):
        return 0
    text = new_text(data.get("tool_name"), tool_input)
    if isinstance(text, str) and "networkidle" in text:
        sys.stderr.write(NOTE.format(name=path.rsplit("/", 1)[-1]) + "\n")
        return 2
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception:
        code = 0
    sys.exit(code)
