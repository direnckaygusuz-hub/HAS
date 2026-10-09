---
name: release-check
description: Sign off a whole web release on one environment: each ticket in it, the regression suite, a crawl diffed against a baseline, the analytics it touches and signed-in areas, ending in GO / NO-GO. Use for "full check before the release", "last check on acc, we go live tomorrow", "check the tickets in this release", "post-release check" — a whole release, not one ticket or one suite run.
---

# Release check

The question is not "does the suite pass" or "does this ticket work" — it is **"can this
release go live?"** That needs several layers, and the failure mode is running one and
calling it the whole check. A "full check" that ran the suite and a status-code sweep
said "no problems"; the user had to ask *did you test the whole site?* and then *what
about the analytics?* — both of which the release needed. This skill is the list that
stops that.

The layers are the other skills. This one decides which to run, in what order, and how
to turn their results into one verdict.

## 1. Pin down the scope before testing anything

- **The tickets in the release.** From the Jira fix version or release page if a
  connector works; otherwise ask for the list. If the connector fails, don't reconstruct
  the scope from the code or the changelog.
- **The environment and the build.** Which environment, and which build is on it now —
  build id, version endpoint, deploy time. Write it down: everything below is a verdict
  on *that* build, and a redeploy halfway invalidates earlier results.
- **The reference.** Production (for a pre-release check), or the same environment
  before the deploy. For the crawl that means a **saved baseline** — check whether one
  exists before you start, and if not, crawl production as the reference.
- **Is every ticket actually in the build?** Check each one for a visible trace of the
  change before testing it. "Not in this build" is its own verdict, different from FAIL:
  a release can be ready for the tickets that are in it and not for the ones that aren't.
- **Release scope versus what's on the environment.** If the environment carries tickets
  from a later release, or misses some from this one, say so — the verdict is for a
  named scope.

Show the plan in the first reply: the layers, what each covers, and what you won't run
and why. It's where the user tells you the analytics ticket is the important one.

## 2. The layers

Run each, or list it under *Not verified* with the reason. Nothing is silently dropped.

| Layer | Skill | Covers |
|---|---|---|
| Regression suite, target + reference | `web-environment-matrix` (`/qa-regression`) | The critical paths, side by side |
| Whole-site crawl, desktop + mobile, diffed against the baseline | `site-crawl-audit` (`scripts/crawl.mjs`, `diff.mjs`) | Every page: status, error states, soft 404s, JS errors, overflow |
| Each ticket in the release | `web-feature-test` | The acceptance criteria, judged as the ticket states them |
| Analytics the release touches | `tracking-plan-audit` | The events of any ticket that adds or changes tracking, on the wire |
| Signed-in areas | `authenticated-testing` | Sign-in works on this build; account pages load |
| Widgets the release touches | `chatbot-ai-testing`, `floating-ui-overlap` | Only when a ticket changes them, or nothing else covers them |

Order: suite and crawl first — they run unattended and catch the broad breakage — then
the tickets, then analytics and signed-in flows. Check the saved session's expiry
before you start, not when the signed-in layer comes up.

Rules that apply across the layers:

- **A status-code sweep is not a crawl.** A page can return 200 and render an error
  card, an endless skeleton or "Page not found". Only the rendered check counts.
- **Diff, don't just list.** On a big site the crawl's value is the *change*: new errors,
  new soft 404s, pages that disappeared. Save today's crawl as the next baseline.
- **Any ticket that touches tracking gets the analytics layer**, even when its
  functional test passes. Tracking regressions are invisible in the UI.
- **Tag-manager changes ship outside the build.** Note the container version per
  environment; a container published to acceptance and production alike changes both
  without any deploy, and differences between environments are a finding to explain.
- **Production stays protected.** A post-release check on production runs only what the
  suite allows there (`web-environment-matrix` tags) — no bookings, no submissions.
- **Every failure gets its location.** Before it counts against the release, check it on
  the reference. *Also on production* means known and unchanged: a real bug, and not a
  reason to stop this release.

## 3. The verdict

One line, for a named scope, with the attribution:

> **GO for the 4.5 scope — no regressions, no blockers.** Three 4.6 tickets aren't in
> this build. One tag-manager change to confirm.

- **GO** — nothing the release introduced blocks it.
- **GO with conditions** — something needs a decision or a confirmation first; name it
  and who decides.
- **NO-GO** — a regression introduced by this release, or a ticket in scope that fails
  its acceptance criteria. Name which.

The verdict follows *The verdict bar* in `qa-test-report`: tickets judged against their
own criteria, nothing passed on a workaround, no "verified" without having run it.

## 4. The write-up

Use `qa-test-report`. A release check is a release decision, so the default is the
**full report**, shaped like this:

1. **Header** — build under test (id, deploy time), reference, account used, date,
   verdict.
2. **Results** — one row per layer *and* one row per ticket, each with its result in
   numbers ("568/568 pages 200, 0 new errors vs baseline"), ✅ / ❌ / *not in this build*.
3. **To confirm before the release** — the conditions, each with the decision needed.
4. **Known and unchanged** — what's broken here and on production alike. Not blockers;
   listing them stops the reader from re-discovering them as regressions.
5. **Not verified** — every layer or ticket that didn't run, and why (needs a real
   payment, the test account has no data, the flag is off here).

For Jira or a chat channel, add the short version: the verdict line plus the retest list
(one line per ticket) from `qa-test-report`, in plain text.

## After the release

The same plan on production, with the production-safe tags only, compared with the
pre-release result on acceptance. The question there is narrower: *did what we tested
arrive, and did nothing break on the way?* Keep that crawl as production's new baseline.
