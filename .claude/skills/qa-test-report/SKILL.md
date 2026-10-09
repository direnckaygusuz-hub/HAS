---
name: qa-test-report
description: Write up a test result in the team's house style: the short plain-text Jira note by default, a retest list for several items, a message to the developer, or the full report on request. Use for "write the test report", "short conclusion for Jira", "note for the ticket", "overview of all the items", "a note for the dev I can post", or after a test run, audit or retest.
---

# Test report — house style

A report is read by someone deciding whether to release. That person wants, in this
order: **the verdict**, what it rests on, and only then the detail.

## Language

**English**, always — tickets are read by developers and clients who do not all read
Dutch. Keep writing English even when the conversation is in Dutch. Only switch when the
user asks for another language for this specific report.

## Pick the format — the short note is the default

Most write-ups are pasted into Jira by the user. Pick the shape from the request:

| Request | Format |
|---|---|
| "note for the ticket", "short conclusion", or nothing specific | Short note |
| several items: audit findings, a retest list, "overview of the items", a release's tickets | Retest list |
| "a note for the dev I can post", "reply to <name>" about a result | Message to the developer |
| "the full report", a release decision, an audit, a document | Full report |

**Anything the user will paste is plain text, not markdown.** Jira comments don't render
markdown: `**bold**`, `#` headings and pipe tables arrive as literal characters, and the
user then asks for it again "in text and not markup". Use plain lines, `-` bullets and
✅ / ❌ / ⚠️ for status. Put the paste-ready text in a code block, so it copies cleanly
and stands apart from anything you say to the user around it. Markdown is for the full
report and Slack, or when asked. If the
user has already posted a comment on this ticket, mirror its shape — they have shown you
the format by writing it.

### Short note

```
Tested on <environment/URL, or build + device> against <reference> as reference — <date>.

Tested:
- <area or flow, operated not just opened>
- <area or flow>

Result: <PASS / FAIL — attribution in one sentence, one line per red item with its cause>
Open: <only if something needs action: what, and ticket or owner>
```

This mirrors the format the team uses in Jira: a *Tested on … against …* sentence, a
*Tested:* bullet list, then the verdict. Drop *Open* when nothing is open. On a retest of
a single fix, *Tested:* is optional — the result line already says what was checked.

Rules for the short note:

- At most ~10 lines — count them before sending. If it does not fit, the extra detail
  belongs in an attachment or the full report, not in the note.
- The *Result* line carries the attribution just like the full verdict does: "PASS —
  the two failures also occur on develop, not caused by this ticket".
- **A failed acceptance criterion leads the result.** Quote it word for word and label
  it as one of the ticket's acceptance criteria — "Acceptance criterion '…': not met —
  …". Never use your own numbering for criteria the ticket doesn't number.
- Name what you did **not** test in one clause under *Tested* if a reader would assume
  it was covered (chatbot, payment, authenticated flows).
- No reproduce steps, selectors, stack traces or tool names — that is for a developer
  bug ticket, not the result note.
- If a finding needs its own bug ticket, say so under *Open* and offer to draft it with
  the `bug-ticket` skill.

### Retest list

For several items at once — audit findings, a hypercare list, the tickets in a release —
one line per item, in the order and with the IDs of the source list:

```
Retest <list name> on <environment> — <date>. <n> fixed, <n> not fixed, <n> not testable.

✅ <ID> <page> — <title>
❌ <ID> <page> — <title>
   Problem: <what still happens, judged against the original issue>
   How to see it: <one or two steps>
   Expected: <what the original issue asked for>
⚠️ <ID> <page> — <title> — not testable here: <reason>

Beyond the issue:
- <ID> <anything noticed that the original issue did not ask for>
```

- Several platforms → one line per item with a mark per platform (`<ID> <title> — iOS ✅
  Android ❌ Web ✅`), not one list per platform.
- Say what each verdict is compared with. "Fixed against the original finding, still
  differs from production" and "not changed" are only meaningful next to their reference
  — a "nothing changed" once turned out to be true only compared with production.
- When the user reports items fixed and asks for the list again, update the same list —
  same order, same IDs — and check that the counts in the header match the lines. A header
  that says 32 above 31 lines makes the whole list suspect.

### Message to the developer

Something the user posts to a developer about a result: written as the user, first
person, addressed to the person if they named one. Always three parts, each its own line —
**what is wrong**, **how to see it**, **what was expected** — and **no diagnosis and no
suggested fix** unless the user asks for one. It should read as if the user wrote it.
Plain text, a few lines.

**Only what the user reported goes in the message.** No example values they didn't give
(a sample order number), no outcomes they didn't mention ("the page then reloads"), no
device or OS they didn't name — the developer reads every line as something the user saw. What would help but is
missing goes in a one-line note *to the user*, outside the message, so they can add it.

### Full report

For release decisions, audits and anything the user calls a report. The rest of this
skill describes it.

## Only what actually ran

Write up only results produced in this session or read from a report file. Anything you
didn't run is written down as **not run**, with the reason — never filled in with the
outcome it would probably have had. A plausible-sounding PASS on something nobody tested
is the most expensive line a report can contain.

## The verdict bar

Every format carries a verdict, and these rules decide it:

- **Judge a retest against the original issue.** Quote the failure condition from the
  original ticket or audit item and decide on that alone. A fix that does what the issue
  asked for is fixed, even if you would have built it differently; everything else you
  notice goes under *beyond the issue*. Holding an item to a stricter bar and reversing
  when the user pushed back happened on the same item in two sessions — settle the bar
  before giving the verdict, not after.
- **The verdict is what a real user gets.** If a check only passed because you bypassed
  part of what a visitor goes through — faking a consent choice, stubbing a broken
  script, getting past a link that does nothing — it is FAIL or *not verifiable on this
  environment*, with the workaround named. Setting up a test condition (a saved session,
  a seeded tier) is fine; bypassing the thing under test is not.
- **A block is only verified next to a success.** "The guard works" needs one legitimate
  attempt that goes through on the same setup. Without it a working guard and a broken
  flow look the same.
- **A negative from your tool's reach is not yet a product FAIL.** "Can't scroll", "can't
  tap", "not found" from automation can be the driver, the viewport or the selector.
  Confirm it the way a person would before it goes in a note (`ios-device-testing` has
  the case that bit three times); until then it is *not verified*.

## Before you write: check your own tooling first

The most common wrong verdict is a defect in the test tooling reported as a defect in
the product. Before a failure goes into any write-up, rule these out:

- **A regex or selector that is wrong, not the page.** Framework markup changes
  (`<title data-next-head>`), a pattern that misses a valid value (a two-character code where you expected three).
- **A wait that ended too early.** `networkidle` fires while a skeleton is still showing,
  and never fires at all on sites with analytics beacons.
- **A parser artefact.** Your own capture code splitting a batched request wrongly.
- **A stale cache or leftover state** from an earlier run.
- **A lost exit code.** `npx playwright test | tail` returns `tail`'s exit code. Read the
  counts from the JSON report, not from scrolled terminal output.
- **Not actually blocking a real user.** An element "outside the viewport" that a user
  reaches by scrolling is not a regression.

And the reverse: **"all green" is only as good as what the suite covers.** If the user
reports something broken that the run passed, the suite has a gap — say so, and fix the
gap before re-running.

## The full report's structure

Before writing a full report, read [references/full-report.md](references/full-report.md):
the header block with the attributed verdict, results per layer as ratios with a footnote
on every non-green cell, what was tested, ticket-specific verification, findings with a
next step, **what looks like a regression and isn't** (never skipped), and stability
findings about the test itself.

## Format

The full report in Markdown, for a document or Slack; everything the user pastes into
Jira in plain text (see *Pick the format*). Do not create a Google Doc, an artifact or a
file unless the user asks for one — paste-ready text in the reply is the default. For an environment matrix: the
matrix as a table at the top, the legend below it, and the reason for each failed or
blocked cell written out underneath.
