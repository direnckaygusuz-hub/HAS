---
disable-model-invocation: true
description: Write the test result in the QA team's house style (short Jira note by default, --full for the full report)
argument-hint: "[ticket or subject] [--full]"
---

Write the test result for: **$ARGUMENTS**

Use the `qa-test-report` skill for the structure and the rules — in particular *Only what
actually ran* and *check your own tooling first*.

- Without `--full`: the format the request calls for — the short Jira note by default,
  the retest list for several items, the message to the developer when it is for one —
  plain text, paste-ready in the reply.
- With `--full`: the full house-style report.
