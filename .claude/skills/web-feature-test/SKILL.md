---
name: web-feature-test
description: Test one feature, ticket, fix or page on a website by hand-driving a real browser: checks from the ticket, the right environment, a verdict on this change. Use for "test this ticket on acc", "test the new filter", "verify the fix", "retest ABC-123", "does this page work", "exploratory test of X" — anything that isn't a full-site crawl or a suite run.
---

# Testing one web feature or ticket

The everyday request: one ticket, one feature, one environment. Not the regression suite
(`web-environment-matrix`) and not the whole site (`site-crawl-audit`) — a focused,
exploratory test that ends in a verdict on *this* change. A whole release of tickets to
sign off is `release-check`, which runs this skill once per ticket.

## 1. Start from the ticket, not from the page

Get the ticket text — read it from Jira if a connector is available, otherwise ask for it.
Without it you get a generic click-through that tests what is easy, not what changed.
If the connector fails ("app is not installed", 403), ask the user to paste the ticket —
don't reconstruct what it asks for from the code. Checks derived from a bundle test what
was built, not what was asked.

From the ticket, write down before touching the browser:

- **The acceptance criteria**, one check each, in the ticket's own words and numbering.
  A FAIL reported against "AC3" that the ticket doesn't call AC3 sends the reader looking
  for the wrong line.
- **The failure mode the change invites.** A new filter → combinations, empty results,
  the URL/back button. A text change → long strings, non-ASCII, the mobile layout. A
  fix → the original reproduction steps. A form → validation, the error state, double
  submit.
- **The neighbours.** What else uses the same component, endpoint or template? A fix to a
  shared card component is a change to every page that renders one.

Show this list to the user in the first reply. It is the test plan, and it is where they
correct a misunderstanding for free.

## 2. Pin down what you are testing against

- **Environment and build.** Which environment, and is the change actually deployed
  there? Look for a build id, version endpoint or meta tag, or check the deploy/PR status.
  Testing a build that doesn't contain the fix produces a confident "not fixed".
- **Cache.** CDNs and service workers serve the old bundle after a deploy. Hard-reload or
  use a fresh context before concluding a change is missing.
- **Flags and content.** A feature behind a flag that is off on this environment, or CMS
  content that differs, is not a bug in the ticket — find out which before reporting it.
- **The time.** Note it; opening hours, timetables and "today" windows change the page.

## 3. Pick the browser

Try the in-app browser pane first — it is the quickest way to look, and the user can watch.
If a site is blocked by policy or the pane isn't available, switch to `playwright-cli`
(see `site-crawl-audit`) or a throwaway Playwright script and don't retry the pane.
Whatever you use, read the page as text (accessibility tree, page text) rather than
reasoning from screenshots; take screenshots as evidence of findings.

In a script, load with `domcontentloaded` and wait for a real element or the feature's
API response — **not `networkidle`**, which never settles on sites with analytics beacons
and hung five sessions in a row (full rule in `web-environment-matrix`). Keep the script,
and any saved session it uses, **in the project folder**: a retest rig in a scratchpad is
gone the next day, and the retest is always the next day. Don't write the rig from
scratch — copy `scripts/steps.mjs` (see *Scripts*) into the project and drive it from there.

A login, checkout or booking → `authenticated-testing` first. A chatbot →
`chatbot-ai-testing`. A floating button → `floating-ui-overlap`. Analytics events →
`tracking-plan-audit`.

## 4. Run the checks

For each criterion, the happy path and then the edges from step 1. Always also:

- **Two viewports:** mobile (375×812) and desktop (1440×900). A feature that works on
  desktop and overflows on a phone is not done.
- **Console and network** while you use it: uncaught errors, responses ≥ 400 with their
  URL. Ignore `net::ERR_ABORTED` (the client cancelling). `steps.mjs` collects these
  and prints them on `close()`.
- **The error state.** Force the API the feature depends on to fail (`page.route` or
  `playwright-cli route … --status=500`) and check the page shows an error, not an
  eternal skeleton or a blank area.
- **Keyboard and names:** can it be reached and operated with Tab/Enter, and do the
  controls have an accessible name? Five minutes, not an audit. When the flow the ticket
  adds can't be operated by keyboard, or focus is lost or invisible in it, that is a
  **FAIL** of the ticket — not a "minor" note under a PASS. For names, `ax-names.mjs`
  reads Chrome's accessibility tree (axe missed empty button names that it caught);
  for announcements, `live-regions.mjs` logs what live regions say.
- **Reload and back.** State that lives in the URL should survive a reload; the back
  button should not break it.

Traps:

- **"I clicked and nothing happened"** is often a multi-step confirm or a slow endpoint.
  Re-read the page and wait for the response before calling it broken.
- **Reproduce it the way a person would.** An element "outside the viewport" that a user
  reaches by scrolling is not a finding.
- **Don't submit anything real** — orders, bookings, messages, tickets — without asking
  first, with what exactly will be sent. On production, don't at all unless asked.
  **A button that sends an SMS, email or one-time code is a real submission** too: the
  "Next" on a 2FA step texts a real phone. Inspect it, don't click it. In a script, run
  with `write-guard.mjs` (`open(url, { guard: true })`): it stubs writes, blocks code
  senders and lets the token refresh through.
- **The bundle locates code; the UI decides the verdict.** Reading a shipped JS chunk is
  a good way to find which component or endpoint is involved, but the same string often
  lives in several forms. A verdict read from the bundle was wrong once because it was the
  checkout card form, not the one under test. Operate the real screen before deciding.
  `chunks.mjs` does the grep.
- **A pass that needed your workaround is not a pass.** If you had to fake consent, stub
  a broken script or click past a dead link to get through, the verdict is what a real
  visitor gets — see *The verdict bar* in `qa-test-report`. `consent.mjs` is for
  testing what sits behind the banner, never the banner itself.

## 5. For a fix: see it fail first

A retest proves nothing unless the test could have failed. Reproduce the original bug
where it still exists — production, another environment, or by forcing the condition —
and only then confirm it is gone on the target. If you cannot reproduce it anywhere, say
so: "could not reproduce the original issue" is a different verdict from "fixed".

**Judge it against the original issue, not a stricter bar.** Quote the failure condition
from the original ticket or audit item and decide fixed / not fixed on that alone.
Everything else you notice goes under *beyond the issue*. Holding a fix to a higher
standard than the issue asked for — and then flipping when the user pushes back — is the
fastest way to lose the reader's trust (full rule in `qa-test-report`, *The verdict bar*).

## 6. For a finding: where does it *not* happen

Before writing a bug up, try it on one other environment (or production) and one other
viewport or browser. "Only on acc", "everywhere, already on production" and "only on
Safari mobile" are three different tickets. When it points at an API, call the endpoint
directly — a browser reports a 404 without CORS headers as a CORS error.

## 7. Close

- Write it up with `qa-test-report` — by default the short Jira note. Each defect that
  needs fixing gets its own ticket via `bug-ticket`.
- Say what you did **not** test (other browsers, signed-in states, other locales, pages
  outside the ticket).
- If the check is worth repeating at every release, offer to add it to the project's
  regression suite with `finding-to-test` — tagged, linked to the ticket, and made to fail
  once on a build that still has the bug.

## Scripts

Project-agnostic Playwright helpers in `scripts/` (Node 20+, `playwright` only). Copy them
into the project repo and run them from there, so Playwright resolves from the project's
`node_modules`; nothing in them names a host. They import each other, so copy the set.

- `steps.mjs` — the step runner: `open(url, { storage, viewport: 'mobile'|'desktop', guard })`, then `go`, `text`, `click` (strict, by role or selector), `shot` (to `./shots/`), `axNames`, `close` (prints ≥ 400 responses, console and page errors). CLI: `node steps.mjs <url> [--storage .auth/acc.json] [--mobile | --both] [--guard]`.
- `write-guard.mjs` — `installWriteGuard(context, { allow })`: stubs non-GET fetch/XHR/form posts, blocks OTP/SMS/e-mail senders even on GET, lets auth/token refresh through (add the project's own refresh endpoint to `allow`).
- `consent.mjs` — `simulateConsent(context, { cmp, choice, mode: 'stub'|'seed' })` and `clickConsent(page)` for Cookiebot, OneTrust, Usercentrics, Didomi; `node consent.mjs <url>` names the CMP. Not a test of the consent flow.
- `ax-names.mjs` — `node ax-names.mjs <url> [--compare <prod origin>]`: interactive nodes with empty or duplicate accessible names; with `--compare`, the ones unnamed only on the first host.
- `live-regions.mjs` — `node live-regions.mjs <url> [--click 'role=button[name="Search"]'] [--seconds 10]`: aria-live / status / alert changes over time, flagging regions inserted with their text.
- `chunks.mjs` — `node chunks.mjs <url> <string | /regex/>`: greps the page's JS, Next.js route chunks included. Locates code; doesn't decide the verdict.

The session helpers (`save-session.mjs`, `session-check.mjs`) are in `authenticated-testing`.
