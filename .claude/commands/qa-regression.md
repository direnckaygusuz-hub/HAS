---
disable-model-invocation: true
description: Run the regression suite against one or more environments and report as a matrix
argument-hint: "[environments, e.g. test,acc] or [--url https://preview…]"
---

Run this project's web regression suite against: **$ARGUMENTS**

Use the `web-environment-matrix` skill for the method.

1. Establish how the suite is invoked in this project — read `package.json` and the
   README before inventing a command. If the project has no regression suite (or no
   project is open), say so and stop: offer to set one up with the
   `web-environment-matrix` skill, or to test the specific change with `web-feature-test`.
   Don't improvise a one-off script and report it as a regression run.
2. Run it against the requested environments. Redirect output to a log file
   (`> run.log 2>&1; echo exit=$?`) — never pipe through `tail`, which hides the exit
   code — and take the counts from the JSON report. If none were given: ask, or take the
   non-production environments declared in the config.
3. Respect the tag permissions per environment. Never force a test onto production that
   is blocked there, not even "just to see".
4. Report as a matrix: passed, failed, flaky, blocked, skipped — with the reason for each
   failed or blocked cell.
5. For every failure, rule out a **content difference between environments** before
   reporting it as a defect.
6. For every failure, establish **where it does not happen** — re-run that case on the
   other environments (the skill's *Broken here versus broken everywhere*).
7. When a failure points at an API, **call that endpoint directly** before believing a
   "CORS" error (the skill's *Reading a failure*).

Close with the short Jira note from `qa-test-report` (verdict with attribution) and, for failures, the traces to debug with.

Then state plainly what the run does **not** cover. "Everything passed" is only true
within the suite's reach, and the reader cannot see where that reach ends by looking at
the matrix. Name the untested areas — pages outside the critical list, widgets with no
test, anything checked by status code alone.
