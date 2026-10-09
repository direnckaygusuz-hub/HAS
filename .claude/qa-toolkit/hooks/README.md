# Hooks

Claude Code loads `hooks/hooks.json` from the plugin automatically. Each hook is one small
python3 script (stdlib only, no network). On any internal error it exits 0 and stays silent,
so a hook bug never blocks a session.

| Hook | Event | What it does | Why (the lesson) |
|---|---|---|---|
| `no-test-pipe.py` | PreToolUse, `Bash` | Blocks (exit 2) a Bash command that pipes a test run (`playwright test`, `npm test`, `pnpm run test:e2e`, `maestro test`, `jest`, `pytest`, ...) into `tail`/`head`/`grep`/`less`/`more`. It tells Claude to redirect instead: `<cmd> > run.log 2>&1; echo exit=$?`. | A pipeline returns the exit code of its last command, so a failing suite piped into `tail` looks green, and the truncated output hides the counts. Read the counts from the JSON report instead. |
| `networkidle-warning.py` | PostToolUse, `Write\|Edit\|MultiEdit` | When a written JS/TS file (`.js .mjs .cjs .ts .mts .cts .tsx .jsx`) contains `networkidle`, shows Claude a short note (exit 2; the file is already written). | `networkidle` never settles on sites with analytics beacons and fires before skeletons resolve. Wait for a real element or `page.waitForResponse` instead (see `web-environment-matrix`). |
| `scratch-session-context.py` | SessionStart | If the session's cwd contains `scratch-workspaces` or `/scratchpad`, adds one line of context: move into the client's project folder first. | QA work started in a scratch folder misses the project's CLAUDE.md, scripts and saved sessions, and its output gets lost. |

What `no-test-pipe` does not block: pipes from commands that aren't test runs (`git log | head`),
`| tee` as the last stage, redirects to a file, and test commands inside quotes (`echo "..."`,
`bash -c '...'`). It also doesn't exempt `set -o pipefail`; redirect to a log instead.

## Turning them off

Installed plugin files get overwritten on update, so editing them won't stick. Claude Code
documents no way to switch off a single hook from a plugin. These are the options:

- **All of this plugin's hooks:** disable the plugin (`/plugin`, or set
  `"enabledPlugins": {"qa-toolkit@<marketplace>": false}` in settings). This also turns off
  its skills and commands.
- **All hooks from every source:** `"disableAllHooks": true` in settings (also reachable
  from `/hooks`).

Tests: `ci/test-hooks.sh` (also run by `ci/check.sh`).
