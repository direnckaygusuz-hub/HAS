---
name: bug-ticket
description: Write one bug ticket in the team's house style — where it does and doesn't happen, steps, expected vs actual, frequency, evidence, severity — and file it in Jira only after the user approves the draft. Use for "file a bug", "write a bug ticket", "log this as a defect", "raise a ticket", "draft the bug for the developers", or an Open item in a test note.
---

# Bug ticket — house style

A test note (`qa-test-report`) answers "can this ship?". A bug ticket answers a different
reader: the developer who has to find and fix one problem, often weeks later, without
you around to ask. Everything they need to reproduce it goes in the ticket; everything
they don't need stays out.

**One defect per ticket.** Three findings from one session are three tickets, linked to
each other if they're related. A ticket with several bugs gets half-closed and never
fully verified.

## Before you write: earn the ticket

Most bad tickets are filed too early. Settle these first:

- **Is it really the product?** Run the "check your own tooling first" list in
  `qa-test-report` — a wrong selector, a wait that ended too early, a parser artefact or
  leftover state is not a bug in the app.
- **Where does it *not* happen?** Try one other environment (or production) and one other
  viewport, browser or device. "Only on acc", "everywhere, already on production" and
  "only on iOS 17" are three different tickets with three different owners and
  priorities. This is the single most useful line in the ticket.
- **Is it content, config or code?** A wrong phone number in the CMS, a flag that is off
  on this environment, a preview host missing from a CORS allowlist — these go to a
  different owner than a code defect. Say which in the ticket, and route it there.
- **How often?** Anything that isn't 100% reproducible gets a count: "3 of 10 attempts".
  For an AI chatbot, never file on one try (see `chatbot-ai-testing`).
- **Is it already known?** Search Jira for the symptom (the error text, the endpoint, the
  screen name) before writing a new one. If a ticket exists, add your evidence as a
  comment instead — with the environment and build, so it counts as a new data point.
- **Is it caused by the ticket under test?** If you found it while testing ABC-123, say
  whether ABC-123 introduced it (it isn't there on the reference build) or it was
  already there. That decides whether it blocks ABC-123.

## The format

```markdown
**Title:** <Area>: <what goes wrong> <where/when, if it narrows it>

**Summary**
One or two sentences: what the user experiences, and the impact.

**Where**
| Environment / build | Result |
|---|---|
| acc — 5.11.0 (4127), Pixel 8, Android 16 | ❌ reproduces 5/5 |
| test — 5.11.0 (4127) | ❌ reproduces |
| production — 5.10.2 | ✅ does not reproduce |

**Steps to reproduce**
1. <Start state: signed in/out, language, flags, data needed>
2. <One action per step, in the words of the UI>
3. …

**Expected**
<What should happen — cite the ticket, spec or design if there is one.>

**Actual**
<What happens instead. Quote error text exactly.>

**Frequency:** <always / x of N attempts>

**Evidence**
- Screenshot or recording of the actual result
- <For web: the failing request (method, URL, status) and console error text>
- <For mobile: the logcat / crash report excerpt, app ID and build>

**Notes**
- Found while testing <ABC-123>; <introduced by it / also present before it>.
- <What you already ruled out: "not a cache issue — reproduced in a fresh context".>

**Severity:** <Blocker / Critical / Major / Minor / Trivial> — <one-line reason>
```

## Rules per section

**Title.** Specific enough to recognise in a list of fifty: `Checkout: "Pay" button does
nothing after changing the delivery date (mobile web)`, not `Checkout broken`. No
environment prefix in the title unless it's environment-specific — then it's the point:
`Chatbot: widget never answers on preview hosts (CORS)`.

**Where.** A table as soon as more than one environment or build was tried — including
the ones where it does **not** reproduce. For mobile, always the build number, device
model and OS version; for web, the browser and viewport if it matters. Note the time for
anything that depends on the clock (opening hours, timetables, "today" windows).

**Steps.** Written for a person, not a test runner: the words on the buttons, not
selectors or test IDs. Start from a state the developer can reach — "signed in as a
customer with a saved card" — never from "after running the regression suite". Test them
once more exactly as written before filing; a step you skipped in your head is the step
they can't reproduce.

**Expected.** Anchor it. "Per the acceptance criteria in ABC-123" or "as on production"
is stronger than your opinion. If there's no source, say it's your expectation and why.

**Actual.** Exact error text in quotes, the HTTP status with the URL, the stack frame.
"It doesn't work" is not an actual result.

**Evidence.** A screenshot of the broken state, and one of the working reference if the
difference is visual. For web: the request and response, not only the console line —
"Failed to load resource" without the URL isn't actionable, and a CORS error may be a
404 in disguise (call the endpoint directly first). For mobile crashes: the `.ips` /
logcat excerpt (see `ios-device-testing`, `android-build-regression`).

**Redact before attaching.** Tokens, cookies, session IDs, email addresses and customer
data in HAR files, logs and screenshots. A bug ticket is read by more people than the
test account's owner — and sometimes by the client.

**Severity** is impact, not effort, and not how annoying it was to find:

| Severity | Meaning |
|---|---|
| Blocker | no workaround, stops a release or a main flow (can't sign in, can't pay) |
| Critical | a main flow broken for a meaningful group, or data loss / security |
| Major | a feature doesn't work as specified, but there's a workaround |
| Minor | cosmetic or edge case with little user impact |
| Trivial | typo-level |

Priority is the product owner's call; suggest one only if asked.

## Filing it

- **Draft first, in the reply.** Show the full ticket and wait for a clear yes before
  creating anything in Jira — a created ticket notifies people and lands on a board.
- With the Atlassian connector: confirm the **project key and issue type** — the user's
  configured project keys are `${user_config.jira_projects}` (empty, or still an unfilled
  `user_config` placeholder: ask);
  check the required fields for that type before creating, and **link** the new bug to
  the ticket under test ("is caused by" / "relates to") so the story shows it. Attach
  screenshots where the connector allows; otherwise say which files the user should
  attach by hand.
- Without a connector: give the ticket as paste-ready markdown (Jira accepts it in the
  new editor) and list the attachments.
- After filing, put the new key under *Open* in the test note, so the two stay connected.

## Retesting a bug

When the fix comes back, follow `web-feature-test` §5: reproduce the original bug
somewhere it still exists first, then confirm it's gone on the fixed build. Comment on
the bug with the same *Where* table, updated — not just "fixed". "Could not reproduce the
original issue" is a different result from "fixed"; say which it is. Once it's fixed,
offer to make it a regression test with `finding-to-test`, so the next release checks it
without anyone remembering to.
