# How to use qa-toolkit

## The mental model

**You don't call skills. They call themselves.**

That is the one thing worth understanding. A skill is not a command you run — it is a
piece of knowledge that loads when your request looks like the work it covers. You
describe what you want in your own words, Claude matches it against the skill
descriptions, and the relevant one loads before it starts working.

So the normal way to use this plugin is: *say what you want, as you would to a colleague.*

The commands (`/qa-regression` and friends) exist for when you want to be explicit — and
for colleagues who don't yet know what the plugin can do and want a menu to pick from.

## What it does and does not do

**It contains knowledge, not code** — almost. The plugin does not ship the Playwright
suite, the Maestro flows, or the analytics checker. It ships the *method*: what to check,
in what order, which traps to avoid, how to report it. A few skills also carry small
generic scripts (`skills/<name>/scripts/`) that a project copies into its own repo, so
nobody rebuilds the same rig from scratch.

In practice that means:

- Open the project that has the actual tooling (the regression suite, the analytics checker, …)
- The plugin then makes Claude use that tooling the way the team has agreed to use it

Open no project at all and the skills still work — they'll just help you *set up* a suite
rather than run one.

## Three ways in

### 1. Just ask (the normal way)

Say what you want. The matching skill loads on its own.

| You type | What loads |
|---|---|
| "regression test this build against production" | `android-build-regression` |
| "did anything disappear after the refactor?" | `android-build-regression` |
| "run test and acc side by side before the release" | `web-environment-matrix` |
| "is the tracking on this site correct?" | `tracking-plan-audit` |
| "which events are we missing?" | `tracking-plan-audit` |
| "write the test report for ABC-123" / "short conclusion for Jira" | `qa-test-report` |
| "file a bug for this" / "write the ticket for the devs" | `bug-ticket` |
| "add a regression test for this bug" / "so we catch it next time" | `finding-to-test` |
| "test ABC-123 on acc" / "verify the fix" / "test the new filter" | `web-feature-test` |
| "test the whole site on acc" / "find every page linking to X" | `site-crawl-audit` |
| "last full check on acc before tomorrow's release" / "check the tickets in this release" | `release-check` |
| "test the chatbot answers" / "test prompt injection" | `chatbot-ai-testing` |
| "does the chat button block anything?" | `floating-ui-overlap` |
| "log in and test the checkout" | `authenticated-testing` |
| "check the app's analytics events" | `mobile-app-analytics` |
| "test ABC-123 on Android" / "verify the fix on the Pixel" | `android-feature-test` |
| "test this on the iPhone" | `ios-device-testing` |
| "test ABC-123 on iOS" / "check VoiceOver and larger text on the new screen" | `ios-feature-test` (with `ios-device-testing`) |
| "there's no live data, force the arriving state" | `mobile-network-injection` |
| "test the Live Activity against the TRD" | `live-activity-testing` |

### 2. A command (when you want to be explicit)

Type `/` and the list appears. Pick one and add the argument:

```
/qa-regression test,acc
/qa-tracking-check my-site
/qa-release-check acc 4.5
/qa-report ABC-123
```

If the bare name doesn't appear in the autocomplete, the namespaced form
`/qa-toolkit:qa-regression` always works.

### 3. Name the skill (when it doesn't trigger)

If Claude starts doing something other than what you meant, say the skill name out loud:

> use the web-environment-matrix skill and check acc before I promote

## Worked scenarios

### An Android refactor ticket

A developer moved classes between modules and says nothing should change.

> The ticket moves Android extensions from core to core-ui. Candidate build is
> 5.10.0+qaTest.4126-1, production 5.10.0 is on the same device. Regression test it.

What you get: the four-layer approach, with the layers run in the right order and the
production comparison used as the reference. Claude will ask about the device and the
builds if you haven't said.

**Give it the ticket text.** The failure mode is derived from what the ticket changes —
a strings pipeline change means non-ASCII canaries, a module move means resource-manifest
diffing. Without the ticket you get a generic smoke test.

### A release going out

> We're promoting to acc tomorrow. Run the regression on test and acc and give me the
> matrix.

You get one run against both environments, results side by side, with blocked tests shown
as blocked rather than failed. Production stays protected by the tags — Claude will not
run a booking flow there even if you ask it to hurry.

### Signing off a release

> Release 4.5 is on acc with ABC-101, ABC-102 and ABC-107. Tomorrow it goes live — check
> everything.

You get the scope first (which tickets, which build, which reference, is there a crawl
baseline), then the suite, a crawl diffed against the baseline, each ticket against its
acceptance criteria, and the analytics of any ticket that touches tracking. The report
ends in GO / NO-GO for the named scope, with *known and unchanged* and *not verified*
listed separately — so a bug that's also on production doesn't block the release, and a
layer that didn't run doesn't pass for one that did.

### A new site needs an analytics audit

> Add the new client site to the tracking check. Here's the plan sheet and the URL.

The onboarding order matters and the skill enforces it: cache the plan, inspect the real
dataLayer *before* configuring the envelope, choose the gate column deliberately, handle
consent. Skipping step two is the mistake that produces a confident report saying the site
tracks nothing.

### Writing it up

> Write the report for this run.

Usually you don't even need to ask — after a regression run, the report skill is the
natural next step. If you want it explicitly: `/qa-report ABC-123`.

By default you get the short English Jira note — *Tested on … against …*, *Tested:*
bullets, *Result* — in plain text, because Jira doesn't render markdown. For a list of
items ("overview of the 19 items") you get the retest list, one line per item; for
"a note for the dev I can post" a short message in your voice, without fix suggestions. Ask for "the full report" (or `/qa-report ABC-123 --full`) when it's a
release decision or an audit. The full report contains a section on what looks like a
regression and isn't. That is deliberate; don't delete it.

### Something you learned

> /qa-learn

At the end of a session where something went wrong in an instructive way. It adds the
lesson to the right skill, bumps the version and updates the installed copy, so it's
active from the next session on.

## How do you know a skill loaded?

Two signals:

1. Claude says so — skill invocations are visible in the transcript.
2. The work has the shape of the method. If you asked for an Android regression and it
   never mentions logcat or the resource manifest, the skill did not load.

To see what's installed:

```bash
claude plugin details qa-toolkit
```

## If it doesn't trigger

- **Say the skill name.** Fastest fix, always works.
- **Check the installed version.** `claude plugin list` — if it's older than
  `version` in `.claude-plugin/plugin.json`, the update step was skipped.
- **Check you're in the right folder.** The plugin is installed at user scope so it's
  available everywhere, but the tooling it drives is per-project.
- **Update after editing a skill.** Editing the source is not enough — see
  [Changing it](#changing-it).
- **Check the description.** If a request that obviously belongs to a skill doesn't match
  it, the `description` field is wrong. That field is what gets matched against, and it
  should be written in the words a person would actually use.

## Testing that the right skill loads

`evals/triggers/` holds one case per typical request: the prompt, the skill that must
load, and the look-alike skills that must **not** (e.g. "check the tracking on the iOS
app" must load `mobile-app-analytics`, not `tracking-plan-audit`). Two cases check that
nothing loads for a request that isn't QA work. Run them after changing a `description`
or adding a skill:

```bash
claude plugin eval <path-to-your-clone> --tag trigger --ablation none --runs 3 -j 4
```

Each case is capped at two turns with only the Skill tool, so a full run is cheap. A
case that fails 1 of 3 runs is a description that is borderline, not noise — sharpen
the wording on both sides. When you add a skill, add at least one case for it and a
`not-` grader to its closest neighbour's case.

## Testing that the skills are followed

Loading the right skill is half of it; `evals/behaviour/` checks that the rules in it are
actually applied. Each case hands Claude a finished test result in the prompt (no device,
no browser) and grades the reply:

| Case | Rule it checks |
|---|---|
| `jira-note-plain-text` | Short note shape; plain text inside the paste block |
| `note-english-from-dutch` | The note is English even when asked in Dutch |
| `failed-ac-verbatim` | A failed acceptance criterion is quoted and leads; no invented "AC3" |
| `retest-list-format` | One line per item, counts that match, plain text |
| `dev-message-no-fix` | The user's voice, no fix or cause, no details the user didn't report |
| `retest-original-issue` | A retest is judged against the original finding; extras kept apart |
| `workaround-not-pass` | A pass that needed a workaround is not a pass |
| `guard-needs-success` | A block is only verified next to a success |
| `driver-negative-provisional` | A driver-only "can't scroll" is not a FAIL yet |
| `bug-draft-before-filing` | The ticket is drafted and approved before anything is filed |
| `release-check-plan` | A release check plans every layer, including analytics for a tracking ticket |

Run them after changing a rule in `qa-test-report`, `bug-ticket`, `web-feature-test`,
`ios-feature-test` or `release-check`:

```bash
claude plugin eval <path-to-your-clone> --tag behaviour --ablation none --runs 3 -j 4 --judge-model sonnet
```

About $4.50 and three minutes. Use the Sonnet judge — the default Haiku judge failed a
release plan that plainly contained the analytics check, three times out of three.

Reading the result: a case at 3/3 is fine. At 2/3, open the failing reply before changing
anything (`--case <name> --keep-temp`, then the `result` line of the trace) — it is either
a real slip worth sharpening the skill for, or a grader judging the wrong part of the
reply. Mechanical rules (plain text, no "AC3") are regex graders with `target:
last_message`; judgement rules are `llm` graders, and their criteria should say which part
of the reply to judge — the paste-ready block, not the notes around it. Graders see the
whole transcript, including the skill text Claude loaded: never quote an eval's own
scenario as an example in a skill, or the judge finds the "bad" phrase in the transcript
and fails a clean reply.

## Settings

Three settings, asked for when you install or enable the plugin from the `/plugin` menu
inside Claude Code. To set or change them later, type this in the Claude input box (it is
not a shell command — there is no `claude plugin configure` in the terminal):

```
/plugin configure qa-toolkit@framna-qa
```

From the terminal, settings can only be given at install time:
`claude plugin install qa-toolkit@framna-qa --config clients_dir=~/Documents/Claude`.
`claude plugin update` doesn't prompt and has no `--config`. An unset setting does **not**
get its default — the commands and skills fall back to the defaults below themselves.

| Setting | Default | Used by |
|---|---|---|
| `clients_dir` | `~/Documents/Claude` | `/qa-project`, the scratch-folder reminder |
| `jira_projects` | empty (asks each time) | `bug-ticket` when filing |
| `toolkit_clone` | empty | `/qa-learn` (maintainers) |

## Client context and setup

**`/qa-project acme`** at the start of client work. It finds the client's project folders
in `clients_dir`, moves the session into the right one (or reads its `CLAUDE.md` if it
can't), and loads `acme-context.md` — environments, builds, flags, analytics containers,
Jira project, test accounts by name, devices, known issues, where the suite lives. No
context file yet: it offers to create one from what the project and you tell it. Never
passwords or tokens in it.

**`/qa-doctor`** on a new machine or when a skill can't find a tool. It lists what's
installed (node, python3, gh, playwright-cli, adb, maestro, mitmproxy, Xcode tools), which
skills each one is for and the fix for what's missing, plus whether the Jira and Maestro
connectors are available in the session. It installs nothing.

## Using it on a new project

The skills are deliberately project-agnostic. On a project with no suite yet:

> Set up a regression suite for this site along the lines we use on our other projects.

You get the structure — tags, environment config, the matrix reporter, the selector rules
— without any project's specifics. The same holds for Maestro flows and for the analytics
checker.

## Changing it

The source is your git clone of the repo (the maintainer's lives at
`~/Documents/Claude/qa-toolkit`). Claude does **not** read skills from that folder: at
install time the plugin is copied into
`~/.claude/plugins/cache/framna-qa/qa-toolkit/<version>/`, and that copy is what loads.
Editing the source changes nothing until you update the installed copy — and the update
only happens when the version number goes up.

The easy way: at the end of a session where you learned something, type

```
/qa-learn
```

It finds your clone, picks the right skill, writes the lesson as a trap, bumps the
version and validates. It commits on a `lesson/…` branch, shows you the diff, and only
pushes and opens a pull request after you say yes. Colleagues get the lesson once the PR
is merged.

By hand:

1. Edit the `SKILL.md`.
2. Bump `version` in `.claude-plugin/plugin.json` (patch for a lesson, minor for a new
   skill). With `git config core.hooksPath .githooks` set, the pre-commit hook refuses a
   commit to `skills/` or `commands/` that forgot this.
3. Validate and update:

   ```bash
   claude plugin validate <path-to-your-clone> --strict
   ```

   ```bash
   claude plugin marketplace update framna-qa && claude plugin update qa-toolkit@framna-qa
   ```

4. Run the same checks CI runs (syntax of every shipped script, skill frontmatter, a
   trigger case for every skill, the version bump):

   ```bash
   ci/check.sh origin/main
   ```

   Every push and pull request runs it on GitHub too (`.github/workflows/checks.yml`),
   together with `claude plugin validate --strict` and a Swift typecheck on macOS. A red
   check on a pull request means don't merge yet.

5. Type `/reload-plugins` in the Claude input box, or start a new session.
   `/reload-plugins` is a Claude command, not a shell command — typing it in a terminal
   does nothing.

To check which version is actually installed:

```bash
claude plugin list
```

**One rule, one home.** A rule that several skills need is written out in full once
and mentioned in one line elsewhere, with a pointer. When you sharpen a rule, change its
home and check the one-liners still agree (`/qa-learn` greps for them):

| Rule | Home |
|---|---|
| `networkidle`, `ERR_ABORTED`, a 404 that looks like CORS, piping through `tail` | `web-environment-matrix` |
| Checking your own tooling before reporting a failure | `qa-test-report` |
| The verdict bar: judge against the original issue, workarounds aren't passes, a block needs a success next to it | `qa-test-report` |
| Plain text for anything pasted into Jira | `qa-test-report` |
| Maestro granting permissions, matching build state, device preflight | `android-build-regression` |
| Push-driven surfaces can't be injected | `live-activity-testing` |
| Signing in without handling credentials | `authenticated-testing` |

Long material lives in a skill's `references/` folder and is only read when needed
(`web-environment-matrix/references/building-a-suite.md`,
`ios-device-testing/references/setup.md`, `qa-test-report/references/full-report.md`,
`ios-feature-test/references/conditions.md`). Keep what's needed on every run in
`SKILL.md`, and leave safety rules there even when they're long — a rule that has to be
looked up gets skipped. Descriptions load in every session, for every skill: keep each
under about 420 characters (CI checks this).

Add what you learn, especially the traps. A skill that only restates the documentation
adds tokens and no judgement. The rules worth writing down are the ones that cost someone
an afternoon.

**Project-specific facts don't go in the plugin.** Hostnames, flag names, container IDs
and test accounts belong in that project's own `CLAUDE.md`. The
plugin stays usable on the next project.
