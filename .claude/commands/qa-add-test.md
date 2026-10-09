---
description: Turn a bug ticket or finding into a regression test in the project's suite, made to fail on the broken build first
argument-hint: "[ticket key or finding]"
disable-model-invocation: true
---

Turn this into a regression test: **$ARGUMENTS**

Use the `finding-to-test` skill. Read the ticket first, find the project's existing suite
(Playwright or Maestro) and add to it with its conventions and tags. Run the test where
the bug still is and show it failing for the ticket's reason, then where the fix is and
show it passing. If the fix isn't deployed yet, add it as an expected failure linked to
the ticket. Commit on a branch and show the diff; don't push to the project's main branch.
