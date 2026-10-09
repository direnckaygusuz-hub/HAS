---
name: tracking-plan-audit
description: Check whether a site actually sends the analytics events its tracking plan prescribes, and onboard a new site into such an audit. Use for "is the tracking correct", "check the tracking plan", "which events are missing", "add site X to the analytics check", GTM/dataLayer verification, or setting up an analytics audit for a new project.
---

# Tracking plan audit

Compares what a site **actually sends** against what its tracking plan **says it should
send**, and reports the difference. Two passes: a static scan of the source for call
sites, and a runtime pass that drives the site in a browser and listens to the dataLayer.

Runs as a CI gate: exit ≠ 0 as soon as an event the plan marks `Done` is missing or
lacks required parameters.

## Everything site-specific lives in one project directory

`projects/<slug>/`. Adding a second site means adding a directory — the checker itself
does not change. If you have to modify the checker to support a site, what you are adding
probably belongs in the project config instead.

## Onboarding a new site

### 1. Cache the plan, don't fetch it

Tracking plan sheets are almost always behind a login: a public CSV export returns 401.
So cache the plan as a **verbatim dump** in the project directory rather than fetching
it. That is deliberate — the checker then runs offline and in CI with no credentials.

**The cache is for the checker, not for questions about the plan.** When the question is
about one specific event or parameter ("is `loyalty_tier` on the checkout events?"),
re-read the **live** sheet first — ask the user for a fresh export if it is behind a
login. A cached plan that lists a key only as a user property will not catch it missing
as an event parameter, and the plan may have changed since the dump. Say which version
of the plan you checked against.

**Write down every normalisation you applied** while transcribing, in a header block:
parameter names you lower-cased, spacer rows you dropped. The next person needs that to
trust the file.

### 2. Establish the envelope before filling it in

The most important and most easily missed step. Some apps wrap every event:

```json
{ "event": "track_properties", "event_name": "Catalog_Item_Click", "properties": { … } }
```

Here the plan's name sits in `event_name` and the parameters one level down. A site that
pushes the plan's name directly on `event` needs no envelope.

**Do not guess here.** Inspect the real dataLayer first and see which payload shapes the
site actually pushes. A wrong envelope fails *quietly*: the runtime pass finds only GTM
internals and the report looks like an app that tracks nothing. That is an expensive
mistake, because it resembles a genuine finding.

Also watch for an ecommerce helper (`track("ecommerce", "select_item", {…})`) — the static
scan recognises those call sites only if you configure the first argument.

### 3. The gate column decides what gets tested

Tracking plans carry several status columns — one from QA, one from the developer.
**Choose deliberately which one counts.** Only rows marked `Done` in that column are
tested; the rest is reported and never fails a run.

Assume the columns contradict each other, in both directions. That is normal, and exactly
why the choice has to be explicit.

### 4. Consent is the gate that hides everything

Many sites emit nothing until a consent manager grants statistics consent. With consent
denied the runtime pass sees nothing — **indistinguishable from a site that tracks
nothing at all**.

Describe the CMP in the config and use consent simulation: it installs a local test
double and blocks the real CMP script, so the site's own gate opens inside the throwaway
audit browser. No banner is clicked and nothing reaches the CMP.

Also record the console message the site logs when it declines to track. That is what
lets the report say **why** nothing fired, rather than only that nothing fired.

## The spec-build warnings are findings

When the plan is converted into a spec, the messages about unparseable rows are
**statements about the sheet**, not parser noise: planning notes parked in the Event
column, duplicated rows, parameters written in an unrecognised form. Read them and feed
them back.

## Conventions the plan may use

Tracking plans are written for humans. Support at least:

| In the sheet | Meaning |
|---|---|
| `Search_Filter_{filter type}` | placeholder — match as a pattern, not a literal |
| `coupon (…, only if valid)` | optional; absence is not a defect |
| `Promo_Code (AABBCC, or null)` | same |
| An Event cell that is not an identifier | planning note; skip with a warning |

Recognised optionality markers: `only if`, `or null`, `if set`, `if available`,
`optional`. Every one of these rules was added *after* a false alarm — if a plan phrases
it differently, extend the list rather than letting the row fail.

## The dataLayer is not proof — read the wire

A parameter sitting in the dataLayer has not necessarily reached GA4. Between the push
and Google sits a GTM container that decides what gets forwarded, and it can drop a key
without saying so. The only proof is the outgoing request: capture
`*.google-analytics.com/g/collect` and read the parameters off it.

| Prefix | Scope |
|---|---|
| `ep.<name>` / `epn.<name>` | event parameter (text / numeric) |
| `up.<name>` / `upn.<name>` | user property |

`ep.loyalty_tier=Gold` on `select_item` is a verified pass. The same key in the dataLayer
alone is a maybe.

**Event scope and user scope are different claims.** A value that already exists as a GA4
user property is not thereby available as an event parameter — that needs its own
event-scoped custom dimension registered in GA4 before it appears in any report. Always
say which scope you verified.

**GA4 batches several events into one request.** Shared parameters — notably the whole
user-property block — are sent once and belong to every event in the batch. Split the
POST body per line and attribute only that line's keys, and the second and later events
look like they lost their user properties. That is a parsing artefact, not a finding.
Merge the query-string parameters into every line before concluding anything. This rule
is here because the artefact was briefly reported as a bug.

## Before calling an event missing, sweep every chunk

"Absent from the code" is a strong claim, so earn it. Take the chunk list from the Next
build manifest rather than the script tags on one page, and fetch all of it — a payment
or checkout step can live in a route chunk the landing page never references. In practice
the whole analytics module tends to sit in `_app`, which makes the sweep quick to confirm.

Then read the GTM container too, and read it carefully: Google's own GA4 library inside
`gtm.js` carries a constant list of every standard ecommerce event name. Finding
`add_payment_info` in there is **not** evidence that the container creates it. Look for a
trigger or a variable that references the name, never for the bare string.

When an event really is absent everywhere, check the plan's implementation column before
writing it up. A column claiming `Done` for an event that does not exist in any bundle is
itself the finding.

## Authenticated flows without handling credentials

Never type a password or a card number, and don't accept them in the chat. Use the
`authenticated-testing` skill: a saved session the user logs in to once, seeding
`localStorage` for values read at push time, and a saved payment method for checkout.

Two points specific to analytics:

- Values like a loyalty tier are often **capitalised in the app** (`Orange`) and
  lower-case in the plan, and **null when logged out**. Check both states and compare
  case-insensitively unless the plan says otherwise.
- Cancelling a test booking is itself tracked (`refund`). Include it in the run rather
  than treating the cleanup as noise.

## Mobile apps

This skill covers the web. For events sent by a native app (Firebase / GA4 for apps),
use the `mobile-app-analytics` skill — the plan and the gate-column rules are the same,
but the capture is different.

## How to work

1. Create the project directory and cache the plan with a normalisation header.
2. Inspect the real dataLayer; set the envelope and ecommerce helper from what you see.
3. Choose the gate column explicitly and record the choice.
4. Configure consent, or establish that there is no gate.
5. Build the spec and **read the warnings** — that is the first round of findings.
6. Run static first, then full. Report missing events, missing required parameters, and
   events the site does send that the plan does not know about.
7. Verify on the wire, not only in the dataLayer, and state whether each parameter
   arrived event-scoped or user-scoped.
