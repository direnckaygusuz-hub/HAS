#!/usr/bin/env python3
"""PreToolUse (Bash): block a test run whose output is piped into tail/head/grep/less/more.

A pipeline returns the exit code of its LAST command, so `npx playwright test | tail -20`
exits 0 even when the suite fails. Exit 2 blocks the call; stderr is shown to Claude.
Any internal error -> exit 0 (never get in the way of a session).
"""
import json
import os
import re
import sys

FILTERS = {"tail", "head", "grep", "egrep", "fgrep", "rg", "less", "more"}
PKG_MANAGERS = {"npm", "pnpm", "yarn", "bun"}
RUNNERS = {"jest", "vitest", "pytest", "py.test", "mocha", "rspec", "phpunit", "ava"}
SUB_TEST = {"go", "cargo", "dotnet", "flutter", "dart", "swift", "deno", "mix"}
WRAPPERS = {"time", "env", "command", "nice", "nohup"}

REASON = (
    "Blocked: this pipes a test run into a pager/filter. A pipeline returns the exit code of "
    "its last command (tail/grep/...), so a failing suite looks green. Redirect instead: "
    "`<test command> > run.log 2>&1; echo exit=$?`, then read the pass/fail counts from the "
    "runner's JSON report (or the log), not from truncated output."
)


def strip_quotes_and_comments(cmd):
    """Replace quoted strings with a placeholder and drop # comments."""
    out = []
    i, n = 0, len(cmd)
    while i < n:
        c = cmd[i]
        if c == "\\" and i + 1 < n:
            out.append("_")
            i += 2
        elif c == "'":
            j = cmd.find("'", i + 1)
            i = n if j < 0 else j + 1
            out.append("Q")
        elif c == '"':
            j = i + 1
            while j < n and cmd[j] != '"':
                j += 2 if cmd[j] == "\\" else 1
            i = j + 1
            out.append("Q")
        elif c == "#" and (i == 0 or cmd[i - 1] in " \t\n;&|("):
            j = cmd.find("\n", i)
            i = n if j < 0 else j
        else:
            out.append(c)
            i += 1
    return "".join(out)


def words(stage):
    toks = stage.replace("(", " ").replace(")", " ").replace("{", " ").replace("}", " ").split()
    while toks and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0]) or toks[0] in WRAPPERS):
        toks.pop(0)
    return toks


def non_flags(toks):
    return [t for t in toks if not t.startswith("-")]


def is_test_run(toks, depth=0):
    if not toks or depth > 3:
        return False
    head = os.path.basename(toks[0])
    rest = toks[1:]
    args = non_flags(rest)
    if head in ("npx", "bunx", "pnpx"):
        return is_test_run(non_flags(rest), depth + 1)
    if head in ("python", "python3") and len(rest) >= 2 and rest[0] == "-m":
        return is_test_run(rest[1:], depth + 1)
    if head in ("uv", "poetry", "pipenv") and args[:1] == ["run"]:
        return is_test_run(args[1:], depth + 1)
    if head in ("playwright", "maestro"):
        return "test" in args
    if head == "cypress":
        return "run" in args
    if head in RUNNERS:
        return True
    if head in PKG_MANAGERS:
        if not args:
            return False
        sub = args[0]
        if sub in ("run", "run-script") and len(args) > 1:
            sub = args[1]
        elif sub in ("exec", "dlx", "x"):
            return is_test_run(args[1:], depth + 1)
        if re.match(r"^(test|t|e2e)([:._-].*)?$", sub) or re.match(r"^test", sub):
            return True
        return is_test_run(args, depth + 1)  # `yarn playwright test`, `yarn jest`
    if head in SUB_TEST:
        return args[:1] == ["test"]
    if head in ("gradlew", "gradle"):
        return any(re.search(r"(?i)test", a) for a in args)
    if head == "xcodebuild":
        return any(a in ("test", "test-without-building") for a in args)
    if head == "make":
        return any(re.match(r"^(test|e2e)", a) for a in args)
    return False


def should_block(command):
    s = strip_quotes_and_comments(command).replace("|&", "|")
    for segment in re.split(r"\|\||&&|;|\n|(?<![>&<])&(?![>&])", s):
        stages = segment.split("|")
        if len(stages) < 2:
            continue
        seen_test = False
        for stage in stages:
            toks = words(stage)
            if seen_test and toks and os.path.basename(toks[0]) in FILTERS:
                return True
            if is_test_run(toks):
                seen_test = True
    return False


def main():
    data = json.loads(sys.stdin.read() or "{}")
    if not isinstance(data, dict):
        return 0
    tool_input = data.get("tool_input") or {}
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str) or "|" not in command:
        return 0
    if should_block(command):
        sys.stderr.write(REASON + "\n")
        return 2
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception:
        code = 0
    sys.exit(code)
