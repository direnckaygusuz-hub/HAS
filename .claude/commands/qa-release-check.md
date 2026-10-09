---
disable-model-invocation: true
description: Full check of a web release on one environment — tickets, suite, crawl diff, analytics — ending in GO / NO-GO
argument-hint: "[environment] [fix version or ticket keys]"
---

Run a release check for: **$ARGUMENTS**

Use the `release-check` skill. Before testing anything, establish the scope (the tickets
in the release, the build on the environment, the reference and the crawl baseline) and
show the plan with every layer — run, or *not verified* with the reason. If the ticket
list can't be read from Jira, ask for it.

Close with the full report from `qa-test-report` and the short plain-text version for
Jira: the verdict line plus one line per ticket.
