# The full report

Read this before writing a full report (a release decision, an audit, anything the user calls a report). The verdict bar, the tooling checks and *Only what actually ran* in SKILL.md apply here too.

## Fixed structure

### 1. Header block

A table with everything that makes the result reproducible. For mobile, at minimum:
build under test, reference build, any cross-check build, device (model, and whether it
was physical), date, **verdict**.

The verdict is one line and states the *attribution*:

> **PASS — no regression attributable to this ticket**

Not plain "PASS". A bare PASS hides whether something was found that came from elsewhere,
and that is precisely what the reader needs to be able to trust.

### 2. Results per layer

One table, one row per test layer or category: what it checks, and the outcome as a ratio
(`26/27 passed`) rather than just PASS/FAIL.

Put a **footnote** on every outcome that is not fully green, saying in one sentence why it
is not a defect — or that it is. The reader must never see a `26/27` without immediately
learning what the one was.

Close with the scale in numbers: assertions, interactions, screenshots. That makes
"tested" checkable.

### 3. What was tested

Per screen or area, emphasising **operated, not merely displayed**. Write down what was
touched: which tiles, which toggles, which fields.

End the section with what you did **not** do, in one line:

> No bookings were made, nothing was submitted, and all flows ran unauthenticated.

That sentence prevents half the questions you would otherwise get.

### 4. Ticket-specific verification

Per point in the ticket: what the failure mode would be, and the evidence that it does not
occur. This is the section that separates a report from a test-run dump — it answers the
question that was asked, not the question the tooling happens to answer.

Phrase it as positive evidence. Not "no errors found", but: these three strings with
special characters render correctly, alongside ASCII labels as a control group, in both
builds with identical counts.

### 5. Findings

Every finding gets: what, where, evidence, and a **risk assessment with a recommended next
step**. A finding without a next step is an observation. When the next step is a bug
ticket, write it with `bug-ticket` and put its key in the finding.

Use a table when the finding spans several builds — where something is and is not present
is often the entire argument.

### 6. What looks like a regression and isn't

**Never skip this section.** If something looks broken and isn't, writing that down is as
valuable as a real finding: it saves the next tester the same hours, and it shows you
investigated rather than missed it.

Name explicitly what settled the question — usually the comparison against the reference
build.

Three recurring members of this section:

- **Broken everywhere, not here.** A fault that reproduces identically on every
  environment is a real bug and a non-event for this release. Say both halves; a reader
  who sees only "bug" blocks a promotion for nothing.
- **Deliberately off.** A feature hidden behind a flag that is disabled in one
  environment is absent, not broken. Quote the flag and its value per environment.
- **Two things with the same name.** When an old and a new implementation of the same
  feature both ship — an old widget behind a dead flag next to its replacement — say
  which one you tested. Finding the wrong one broken is an easy hour lost.

### 7. Stability findings about the test itself

A test that failed on a timeout or a flaky environment is not a defect in the product, but
the reader needs it to interpret your numbers. Say whether it was fixed and re-verified.

## Writing rules

- **Separate signal from expectation.** Extras in a QA build, content differences between
  environments and renamed resources are not findings. Say why not.
- **Show the asymmetry.** "0 missing, 163 extra" says more than "differences found".
- **Numbers over adjectives.** "104,398 lines of logcat scanned", not "thoroughly checked".
- **Be explicit about what a result does *not* prove.** A green assertion on a screen with
  a missing drawable is still green. Say so where it matters.
- **One question per finding for the developer**, at the end, concrete enough to answer
  with yes or no.
