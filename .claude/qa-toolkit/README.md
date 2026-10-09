# qa-toolkit

The QA team's working practices, packaged as a Claude Code plugin. Install it once and
Claude knows our approach to regression testing, analytics audits and reporting in every
project — without you explaining it each session.

The plugin is mostly **knowledge, not code**. The suites themselves (Playwright and
Maestro suites, analytics checkers, crawlers) stay in each project's own repository; this
plugin teaches Claude how to use them and why they are the way they are.

The exception is a few small, generic rigs that used to be rebuilt in every project —
the overlap analysis, the iOS screen capture and driver client, the mitmproxy injector,
the Android resource and logcat comparisons. Those ship in the skill's `scripts/` folder.
A project **copies** them into its own repo and adapts them there; don't run them from
the plugin cache, whose path changes with every version.

## Install

In a terminal:

```bash
claude plugin marketplace add git@github.com:floris-andrea/QA-Toolkit.git
```

```bash
claude plugin install qa-toolkit@framna-qa
```

Or inside Claude Code, type `/plugin marketplace add git@github.com:floris-andrea/QA-Toolkit.git`
and `/plugin install qa-toolkit@framna-qa` in the input box. If the repo is private, you
need read access on GitHub and an SSH key set up.

To get updates later:

```bash
claude plugin marketplace update framna-qa && claude plugin update qa-toolkit@framna-qa
```

**Maintainer:** work in your local clone. To make your local folder the source instead
of GitHub, add the folder as the marketplace (`claude plugin marketplace add
<path-to-your-clone>`). Enable the version-bump check once per clone:

```bash
git config core.hooksPath .githooks
```

After changing a skill, bump the version and update the installed copy — see
[HOWTO.md](HOWTO.md#changing-it). Editing the source alone changes nothing. `ci/check.sh
origin/main` runs the same checks as CI before you push.

Project-specific facts (hosts, flags, container IDs, test accounts) don't belong in the
plugin; put them in the project's own `CLAUDE.md`, or in a shared `<client>-context.md`
that `/qa-project` creates for you. When several repos belong to one
client, keep one shared context file and import it from each `CLAUDE.md` with
`@../<client>-context.md`.

See **[HOWTO.md](HOWTO.md)** for how to actually use it day to day.

## What's in it

### Skills — load automatically when the work matches

| Skill | For |
|---|---|
| `web-environment-matrix` | Running the same Playwright checks against preview, test, acceptance and production in one run, with tags governing what may run where. |
| `release-check` | Signing off a whole web release: every ticket, the suite, a crawl diffed against a baseline, the analytics it touches — ending in GO / NO-GO for a named scope. |
| `web-feature-test` | Testing one ticket, feature or fix on a website: checks derived from the ticket, the right build and environment, see a fix fail before calling it fixed. |
| `site-crawl-audit` | Crawling a whole site: errors on every page, axe, mobile overflow, broken phone links — and inventories of where something is mentioned or linked. |
| `chatbot-ai-testing` | AI chatbots: answer quality, dead links, made-up facts, repeat runs, prompt injection with canary tokens, and why a widget fails on one environment. |
| `floating-ui-overlap` | Whether a floating button or overlay covers anything, across pages, viewports and scroll positions, and whether its panel is really modal. |
| `authenticated-testing` | Signed-in flows, checkout and bookings without anyone typing or pasting a password or card number. |
| `tracking-plan-audit` | Checking whether a site really sends the events its tracking plan prescribes, and onboarding a new site into the audit. |
| `mobile-app-analytics` | The same for native apps: Firebase events captured from the device, parameters verified. |
| `android-build-regression` | Comparing an Android build against a reference build in four layers: resource manifest, Maestro flows, logcat, pixel diff. With a device preflight and build-state matching. |
| `android-feature-test` | Testing one Android ticket or fix: checks from the ticket, the right build and flags, and the device conditions that break features — rotation, process death, font size, dark mode, offline, deep links. |
| `ios-feature-test` | Testing one iOS ticket or fix: the case table from the ticket, then VoiceOver (with the user driving and the speech captured), Dynamic Type, landscape, contrast, touch targets, offline, background work and attempt-limited inputs. |
| `ios-device-testing` | iOS on a physical iPhone, where Maestro doesn't reach: what to automate, USB capture, devicectl, splitting the taps with the tester. |
| `mobile-network-injection` | mitmproxy on Android and iOS: record, replay and rewrite API responses to force states the real backend isn't in. |
| `live-activity-testing` | Live Activities and live notifications: every state on both surfaces, the permission matrix, and what push makes untestable. |
| `qa-test-report` | Writing it up: a short English Jira note by default, the full house-style report on request. |
| `finding-to-test` | Turning a bug or finding into a permanent regression test in the project's suite: tagged, linked to the ticket, red on the broken build and green on the fixed one. |
| `bug-ticket` | One defect, one ticket: where it does and doesn't happen, steps a person can follow, frequency, evidence, severity — filed in Jira only after you approve the draft. |

You don't have to invoke them. Ask "regression test this build against production" and
the right skill loads itself.

### Commands — the explicit way in

| Command | Does |
|---|---|
| `/qa-regression test,acc` | Runs the regression suite against the named environments and reports as a matrix |
| `/qa-release-check acc 4.5` | Full release check on one environment, ending in GO / NO-GO |
| `/qa-tracking-check my-site` | Runs a tracking plan audit, or sets up a new site |
| `/qa-report ABC-123` | Writes the short Jira note (`--full` for the full report) |
| `/qa-add-test ABC-123` | Turns a fixed bug or a finding into a regression test in the project's suite |
| `/qa-project acme` | Loads (or creates) the client's context file and moves the session into its project folder |
| `/qa-doctor` | Checks the tools and connectors the skills expect, and how to fix what's missing |
| `/qa-learn` | Adds what you learned this session to the right skill, bumps the version and updates the installed copy |

## Where this comes from

Every rule in these skills was learned the expensive way once. A few that make the
difference:

- A passing `assertVisible` does not prove the screen is correct — a missing drawable
  still renders, just empty. Only logcat reveals it.
- A QA build often points at a different CMS environment than production. Anyone who
  doesn't establish that before interpreting a pixel diff reports promo cards as
  regressions.
- A misconfigured dataLayer envelope fails **quietly**: the report looks like a site that
  tracks nothing.
- The production lock belongs in the test fixture, not the CLI. Otherwise you bypass it
  by typing a different command.
- Selecting on generated CSS classes breaks at the next deploy without anything being
  wrong.

## Extending it

Adding a skill is a directory with a `SKILL.md`:

```
skills/my-practice/SKILL.md
```

```markdown
---
name: my-practice
description: Describe WHEN Claude should use this, in the words someone would type.
  This is what gets matched against — be specific.
---

# My practice

The steps, and above all: the traps and why they exist.
```

The `description` is the field that matters most: Claude decides relevance from it. Write
it from the user's request, not from the content.

Validate your change before sharing it:

```bash
claude plugin validate <path-to-your-clone> --strict
```

Or let `/qa-learn` do all of it.

Write down what you learned, not what the documentation already says. The value of this
plugin is in the traps.
