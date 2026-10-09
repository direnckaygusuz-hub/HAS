---
name: web-environment-matrix
description: Run the same Playwright regression checks against multiple environments (preview, test, acceptance, production) in one run and report the result as a matrix, with tags governing what is allowed to run on production. Use for "regression test before the release", "test and acc side by side", "check this environment before promotion", setting up a web regression suite, or adding checks to one.
---

# Environment matrix for web regression

Replaces the repeated manual testing at every promotion (preview → test → acceptance →
production). One run, all environments, results side by side:

```
                                          test   acc   prod
Homepage loads without errors               v      v     v
Robots meta follows the environment rule    v      v     v
Booking: search shows results               v      X     o
```

`v` passed · `X` failed · `!` flaky · `o` blocked on this environment · `-` skipped

Signing off a whole release — its tickets, a crawl, the analytics — is `release-check`;
this skill is the suite layer of it.

A blocked test is **not a failure**. That distinction is the core of the report: without
`o` alongside `X`, a reader cannot tell whether something is broken or deliberately not
run.

## Running it: tooling traps that produce wrong verdicts

- **Runs go through Playwright, not a browser pane.** A matrix needs repeatable runs,
  several environments at once and a JSON report — drive it with the project's
  Playwright setup (or a throwaway script). An in-app browser pane is fine for looking
  at a single failure, but it may be blocked for external sites by organisation policy:
  try it once, and if a site is refused, don't retry — use `playwright-cli` instead.
- **Never pipe the test command through `tail`, `head` or `grep`.** The pipeline returns
  the last command's exit code, so a failing suite looks like it passed, and a run
  watched through `tail` buffers and shows nothing. Write to a file with
  `> run.log 2>&1` and read the exit code and the counts from the JSON reporter.
- **`networkidle` is not "the page is ready".** Sites with analytics beacons never go
  idle, so waits time out; pages that render a skeleton first go idle *before* the
  content or the error state appears. Wait for something the page actually renders —
  a row, a heading, or the error card — with an explicit timeout long enough for the
  slowest endpoint (an error that appears at ~10 s needs more than the default).
  Better still, **wait for the API response the page depends on** and assert its status —
  that is both the readiness signal and the most useful evidence when it fails:

  ```ts
  const res = page.waitForResponse(r => r.url().includes('/api/availability') && r.request().method() === 'GET');
  await goto('/availability/');
  expect((await res).status(), 'availability API').toBeLessThan(400);
  await expect(page.getByText(/unable to load/i)).toHaveCount(0);
  ```
- **Load credentials from `.env`.** A suite that reads `process.env.X` without loading
  `.env` silently skips its authenticated tests. Make a missing credential a loud skip
  with a reason, never a silent one. For how to sign in without anyone pasting a password
  into the chat, see the `authenticated-testing` skill.
- **Check it blocks a real user before calling it a regression.** "Element outside the
  viewport" is not a finding if a user reaches it by scrolling. Reproduce it the way a
  person would — scroll, the real viewport size — before writing it down.
- **Content depends on the clock.** Timetables, "today" windows, opening and operating hours
  change during the day. Assert structure, and note the time of the run.
- **Previews are not smaller copies of test.** They often lack `/sitemap.xml` and
  `robots.txt` (404), use a different tag manager container, and are missing from API
  CORS allowlists. Put these in the environment config (see below), not in the tests.

## Production safety: tags, and the lock lives in the fixture

Every test carries a mandatory tag saying what it does. Every environment declares which
tags may run there.

| Tag | Meaning | Production |
|---|---|---|
| `@read-only` | only reads | allowed |
| `@booking-search` | fills a form up to the summary, never pays | blocked |
| `@auth` | signs in with real credentials | blocked |
| `@chatbot` | sends a message to an AI backend | blocked |

That last row generalises: **anything that costs money per interaction, or leaves a
record someone else has to clean up, earns its own tag.** An AI chat message bills per
token and creates a conversation log. So does an outbound SMS, a support ticket, a
webhook delivery. The question is not "does it write to our database" but "does this
leave a trace outside the test".

A tag also earns its keep when a feature is simply *off* in one environment. If a
feature flag hides the widget on production, an untagged test there fails for the wrong
reason. Blocked (`o`) says "deliberately not run here"; failed (`X`) says "broken". Only
one of those is true.

Two rules make this work:

1. **The lock lives in the fixture, not the CLI.** Then it holds even when someone
   invokes `npx playwright test` directly. A safety measure you can bypass by typing a
   different command is not one.
2. **A tag is mandatory.** Without one the test fails with a clear message rather than a
   silent assumption. Forgetting is the normal mistake; make it loud.

One nuance worth documenting: validation tests that enter *invalid* values caught
client-side may run on production — no request reaches the server. Write exceptions like
that down next to the tag, or the rule gets stretched at the first hesitation.

## Reading a failure

### Debugging trap: a 404 without CORS headers reads as a CORS error

When an API returns an error status *and* omits `Access-Control-Allow-Origin`, the
browser is not allowed to reveal the status. It reports a CORS violation. Engineers then
go and audit CORS configuration, which is fine and correct and entirely beside the point,
because the endpoint was returning 404 the whole time.

Before touching CORS config, call the endpoint directly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/v1/thing
```

A 404 there means the route is missing or not deployed. Only if that returns 200 while
the browser still complains is it genuinely a CORS problem. The same trap in reverse:
a preflight that answers `204` with `access-control-allow-methods` but *no*
`access-control-allow-origin` is a real CORS fault — check for that specific header
rather than assuming a 2xx preflight means success.

### Cancellation is not failure

A browser-based check drowns in noise unless you are precise about which signals mean
something. The one that catches everybody: **`net::ERR_ABORTED` means the client
cancelled the request**, not that anything went wrong. Apps do this constantly and
correctly — a framework prefetches a page and abandons it when you navigate elsewhere, a
redirect cancels the navigation underneath it, a component aborts an in-flight call when
its parameters change.

That last one is intermittent, which is worse than noisy: the same page fails one run and
passes the next, and the suite acquires a reputation for lying.

Filtering it hides nothing, provided you keep the other channels:

| Signal | Means | Keep |
|---|---|---|
| `ERR_ABORTED` | client cancelled | filter |
| HTTP ≥ 400 response | server refused | keep, with the URL |
| `ERR_FAILED`, `ERR_CONNECTION_*`, `ERR_NAME_NOT_RESOLVED` | request never completed | keep |
| uncaught exception | code fell over | keep |

Record failing *responses* with their URL, separately from console messages. Browsers log
"Failed to load resource" without saying which resource, and a finding you cannot trace to
an endpoint is not actionable.

Keep the noise list short, specific, and annotated with where each entry was actually
observed. A filter added preventively, "just in case", is how a suite quietly stops
checking.

### Broken here versus broken everywhere

An error that reproduces identically on test, acceptance *and* production is a real bug,
but it is not a promotion signal — nothing regressed, it was already like that. If the
suite goes red on it every run, people stop reading the matrix, and then it also hides
the failures that do matter.

Keep a narrow allowlist for these, under two rules:

1. **Scoped to one path.** Never site-wide — a site-wide suppression of, say, hydration
   errors will hide the next real one.
2. **Tied to an open ticket.** Without that, the allowlist is where bugs go to be
   forgotten rather than administered.

Note in the entry that you verified it on every environment, and when. That date is what
lets the next person decide whether to re-check.

## Building or extending the suite

Setting up a suite, or adding checks to one, is in
[references/building-a-suite.md](references/building-a-suite.md) — read it before writing
or changing tests. In short:

- **A 200 is not health.** Every critical path is loaded in a real browser (not a
  status-checked subset), with the visible error state asserted absent, and every
  detail page listed — not just the section index.
- Feature flags compared per environment: fail when the flag service is unreachable,
  report (don't fail) when flags differ.
- Assert structure, not values; environment differences live in config
  (`expectNoindex`, `expectCdnHeaders`, `expectSitemap`, `allowedTags`), not in tests.
- Selectors: `getByRole` → `getByLabel` → stable id; never generated classes or
  auto-numbered ids; all locators in one file; scope option queries.
- Every new check goes red once before you trust it.

## Output

Report the failing `test.step` title in the cell's reason. Always deliver four things:
an HTML matrix with the reason per cell, the same matrix as
markdown to paste into a ticket or Slack, machine-readable JSON, and the standard
Playwright report with traces for debugging. Keep a trace for every failed test.

Then say what the run does **not** cover. If the user reports something broken that the
matrix showed green, treat it as a gap in the suite: add a test that fails on it
(`finding-to-test`), confirm
it fails, and only then re-run.

Write up the conclusion with the `qa-test-report` skill — by default the short Jira note.
