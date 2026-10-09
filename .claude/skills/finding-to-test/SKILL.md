---
name: finding-to-test
description: Turn a bug, retest item or audit finding into a permanent regression test in the project's suite — a Playwright check or a Maestro flow that fails on the broken build, passes on the fixed one, and is tagged and linked to the ticket. Use for "add this to the suite", "make a regression test for this bug", "turn the finding into a test", "so we catch this next time", "automate this retest", or after a fix is verified.
---

# Turning a finding into a regression test

A finding retested by hand comes back every release. Once a bug is understood — and
especially once its fix is verified — it belongs in the suite, so the next run checks it
without anyone remembering to. This skill writes that one test; the suite's own
conventions live in `web-environment-matrix` (web) and `android-build-regression`
Layer 2 (Maestro).

## 1. Is it worth a test?

Yes when the finding can come back: a regression after a refactor, a fix in shared code, a
content rule (phone links, hard-coded production links), an accessibility name, a flag
that must stay off. No when it was a one-off data problem, or the only way to check it is
a real payment or a push that a test can't trigger — say so and leave it as a manual check.

## 2. Start from the ticket, not from your memory of the session

Read the bug ticket (or the audit item) and take from it: the start state, the steps, the
expected result, and **where it did not happen**. The test asserts the *expected*
result; the steps are its setup. If the ticket is vague, sharpen the ticket first — a
test built on a guess encodes the guess.

## 3. Put it where the suite already is

- **Find the suite before writing anything:** `package.json` scripts, `playwright.config.*`,
  a `flows/` or `.maestro/` folder, the README. Add to it; never start a second suite next
  to it. No suite at all → offer to set one up (`web-environment-matrix`,
  `references/building-a-suite.md`) instead of leaving a stray script.
- **Follow its conventions:** its fixtures, its locator file, its environment config. A
  test that works only on the URL you happened to test is a test of that URL.
- **Tag it.** Web: the suite's mandatory tag (`@read-only` unless it submits anything;
  then the tag that blocks it on production). Maestro: the flow tags (`smoke`, `forms`,
  `nav` …). Add a tag or annotation with the ticket key, so a red run points at the
  history.
- **Name it after the behaviour, with the key:** `ABC-123: Save address works with a
  space in the postcode`, not `bug fix test`.

## 4. Write it the way the finding was found

- **Assert the user-visible outcome** the ticket expects — a heading, a message, a saved
  value, an accessible name — not an implementation detail.
- **Selectors:** `getByRole` with the exact name → `getByLabel` → a stable id; Maestro: an
  id, then text. Never generated classes or coordinates (rules in `building-a-suite.md`).
  If the control has no stable handle, say so — a missing accessibility id is a finding.
- **Waits:** for the element or the response the page depends on, never `networkidle`.
- **Accessibility findings:** assert the specific thing that was wrong (`toHaveAccessibleName`,
  an axe run scoped to that component with the one rule that failed), not a whole-page
  axe run that fails for unrelated reasons.
- **Content findings** (a broken `tel:` link, a production link on acc): assert the rule
  across the pages that showed it, from the crawl's list.
- **Nothing real:** no orders, bookings, messages or codes. Route or stub the write
  (`page.route`, the `write-guard` in `web-feature-test`) and assert the request the page
  would have sent.

## 5. Make it fail, then pass

A regression test that has never been red proves nothing.

1. **Run it where the bug still is** — the build before the fix, production if the fix
   isn't there yet, or with the condition forced. It must fail, and fail for the reason in
   the ticket (read the error, not just the colour).
2. **Run it where the fix is.** It must pass.
3. Run it on the other environments the suite covers, to check it isn't environment-bound.

If the fix isn't deployed anywhere yet, commit it as an **expected failure** linked to the
ticket (`test.fail()` with the key in the annotation; a Maestro flow excluded by a
`pending` tag) so it turns into a real test the day the fix lands — and say so in the
ticket.

Redirect test output to a log file and read the JSON report; never pipe a run through
`tail`.

## 6. Close the loop

- In the ticket: a comment with the test's name and path, and where it ran red and green.
- In the report or retest list: the item is now *covered by <test name>*.
- Commit on a branch in the project's repo; the user reviews and merges. Don't push to the
  project's main branch.
