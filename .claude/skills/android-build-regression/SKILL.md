---
name: android-build-regression
description: Regression-test an Android build against a reference build in four layers (resource manifest, Maestro UI flows, logcat, pixel diff). Use for a refactor, cleanup or migration ticket where the app is supposed to behave identically, for "regression test this build", "compare against production", "did anything disappear in the refactor", or when setting up Maestro flows for an Android app.
---

# Android regression in four layers

For a ticket that is supposed to produce **no visible change** — a refactor, a module
move, removed dead code, a changed translation pipeline. The question is not "does the
app work" but "did anything quietly disappear". For testing one new feature or fix,
use `android-feature-test` instead.

## The premise: compare against a build, not a baseline

Install the **production build alongside the candidate** on the same device. A pure
refactor should render identically to production, so the comparison is a direct answer
rather than an inference from a stored baseline. Baselines go stale; a second build on
the same device does not.

Use three builds where you can: candidate, production (reference), and a pre-refactor
build from the same release line (cross-check). The third settles "was it already like
this?" without argument.

## Preflight: device and tooling

Every one of these has cost a session several turns. Check them before the first flow:

- **`adb` on PATH.** On macOS it usually lives in `~/Library/Android/sdk/platform-tools`.
  Export it for the session rather than asking the user to fix their shell.
  `source scripts/find-tools.sh` does this, and puts the newest `aapt2` on PATH too.
- **The device is authorised.** `adb devices` must show `device`, not `unauthorized` or
  `offline`. If it drops to `unauthorized` mid-run, the phone is showing the "Allow USB
  debugging" prompt again — ask the user to unlock and accept, then re-run the flow that
  was in flight. Ask them to keep the screen awake (Developer options → Stay awake).
- **Only one Maestro client per device.** The Maestro CLI and the Maestro MCP both hold
  the device's driver; running the CLI while an MCP session is live kills the MCP driver.
  Pick one for the run. To reset a stuck driver: `adb shell am force-stop
  dev.mobile.maestro`, `adb shell am force-stop dev.mobile.maestro.test`.
- **Recovering a dropped device:** `adb reconnect` then `adb wait-for-device`. If no
  "Allow USB debugging" prompt appears, toggle USB debugging off and on.
- **Screenshots go where you tell them.** Pass `--debug-output <dir>` (and write
  screenshots with an explicit path), or they end up in Maestro's own debug directory.
- **Which build is actually installed.** `adb shell dumpsys package <appId> | grep
  versionName` for each app, and compare with the ticket before starting. The build on the
  phone is often not the one the ticket names.
- **Guard ad-hoc `adb input` against the wrong app.** For exploratory driving outside
  Maestro, check `dumpsys activity activities | grep topResumedActivity` before every tap
  or swipe, and refuse when the app under test isn't in front. One back press too many
  left the app, and the next tap landed on the launcher's search bar mic and started Google
  voice search. The same slip can open other apps or change settings.
- **A release-type build isn't debuggable.** `run-as <pkg>` fails ("package not
  debuggable"), so the app's Remote Config and data files can't be read on acceptance or
  production builds. Infer a flag from what the UI shows (a button present or absent),
  and say in the report that the flag value is inferred.
- **Make scripts device-agnostic.** Don't hard-code a serial, resolution or Android
  version — the next run is on a different phone.

## Match the state of both builds before comparing

A comparison between two builds is only fair if they start from the same state. Before
any flow:

- **Same auth state.** One build signed in ("Hi, <name>") and the other signed out
  changes half the screens — a 15-of-29 failure rate on one run came from exactly this.
  Sign both out, or both in on the same test account.
- **Same first-run state.** Dismiss onboarding and "Got it" modals in both. Make the
  dismissal conditional, so a flow works whether or not the prompt appears:

  ```yaml
  - runFlow:
      when:
        visible: "Got it"
      commands:
        - tapOn: "Got it"
  ```

  Put these in one shared launch subflow (`common/launch.yaml`) that every flow starts
  with, rather than repeating them per flow.
- **No leftovers from your own suite.** Search history, recently viewed items, tracked
  items and favourites written by a previous flow contaminate the next comparison. Clear
  them, or clear app data, between runs.
- **Feedback and rating prompts.** Close them without answering — never tap Yes/No, that
  sends real feedback.
- **Permissions.** Maestro's `launchApp` grants all permissions by default (look for
  `pm grant` in logcat). A test of a permission prompt then reports the prompt as missing
  when the app is fine. Launch the app outside Maestro for those tests —
  `adb shell monkey -p <appId> -c android.intent.category.LAUNCHER 1` — and drive it by
  taps, or try `launchApp: { permissions: { all: deny } }`. Set the starting permission
  state with `pm revoke` / `pm grant` and read it from the *runtime permissions* block of
  `dumpsys package`, not the requested-permissions list.
- **Never `clearState: true` on a real device you don't own** — it wipes the login and push
  token. Prefer resetting the specific state.

## The four layers

Each layer catches failures the others leave **green**. Do not skip one.

### Layer 1 — Static resource manifest

Diff the set of shipped strings, drawables, fonts and assets between the builds.

Catches: a string or asset that stopped shipping — **including on screens no test
visits** — and the R8 shrinker stripping something now only referenced from the new
module.

Report in both directions:

```
only in reference : 0 resources     <- this is the signal
only in candidate : 163 resources   <- usually debug tooling, expected
```

Only `only in reference` is a finding. Extras in a QA build are normal (chucker,
logging). Watch for **renamed** resources: a QA build with resource name obfuscation
ships `res/H8.ttf` where production ships `res/font/inter_bold.ttf` — three fonts in
each, nothing lost. Count, don't just compare names.

**Compare values, not only names.** A string resource that still exists but whose text
changed ("Order Online" → "Shop Now") passes a name-only diff. Dump both string
pools and diff the values too:

```bash
aapt2 dump strings reference.apk | sort > ref.txt
aapt2 dump strings candidate.apk | sort > cand.txt
comm -23 ref.txt cand.txt   # values only in the reference
# name -> value, to see which resource changed:
aapt2 dump resources candidate.apk | grep -A1 'string/<name>$'
```

`aapt2` is in the newest `~/Library/Android/sdk/build-tools/*/`. Pull the installed APK
with `adb shell pm path <appId>` and `adb pull`.

Compare as **sets**, not ordered lists — resource order differs between builds.

`scripts/snapshot-resources.sh` records one build (names, per-type counts, values, files);
`scripts/compare-resources.sh` compares two snapshots in both directions.

If the diff shows a missing asset, establish whether **any** dex reads it before
calling it a bug. A seed or migration fixture whose own keys appear in no build,
production included, is exactly the "unused code" the ticket set out to remove. Report
it as *low risk, worth one confirmation* and ask the developer whether it was deliberate.

### Layer 2 — UI flows (Maestro)

Flows that visit every screen and **operate** it. Tag them so you can run selectively:

| Tag | Meaning |
|---|---|
| `smoke` | does the screen come up at all |
| `strings` | labels that are local string resources |
| `assets` | screens that lean heavily on drawables |
| `interactions` | taps things rather than only reading |
| `nav` | navigation routes there and back |
| `forms` | text fields, toggles, validation |
| `encoding` | non-ASCII canaries |
| `lifecycle` | background and restore |

**Make each new flow fail once.** Point an assertion at text that isn't there, or run it
against a build where the screen is known broken, and confirm it goes red. A flow that has
never failed may be asserting on something that is always visible.

**Missing accessibility IDs are a finding.** When a control can only be reached by text,
index or coordinates, note it and ask the developers for a `resource-id` /
`contentDescription` (Android) or `accessibilityIdentifier` (iOS). Text selectors break on
copy changes and translations; coordinates break on the next device.
`scripts/enum-clickable.py` lists every tappable on the screen as ID, TEXT-only or NONE.

**Operating it is the point.** A broken extension still renders a perfect-looking form;
only *using* it reveals the break. Form flows are therefore the most valuable ones for a
ticket that moves UI extensions: type into fields, toggle visibility both ways, make
validation fire with an `example.invalid` address. Never real credentials, never
actually submit.

### Layer 3 — Runtime logcat

Scan logcat, **scoped to the app's UID**. This is the layer most often skipped and the
one that returns the most.

> `assertVisible` passing does not mean the screen is correct. A missing drawable still
> renders, just empty. Only the logged exception reveals it.

Catches: drawables resolving to blank, fonts silently falling back, resources looked up
by name and not found. All with green assertions.

Scope by UID, not by tag or package string:

```bash
uid=$(adb shell dumpsys package <appId> | grep -m1 -oE 'appId=[0-9]+' | cut -d= -f2)
adb logcat -v time --uid="$uid" > logcat-candidate.txt
```

Manufacturer noise is not the app. On Samsung, `rampart_*` notification channels and
their logs belong to the OS, not to the app under test.

`scripts/logcat-scan.sh` captures by UID and scans; its noise list sits at the top.

### Layer 4 — Pixel diff against the reference build

Screenshot the same screen in both builds and compare pixels. Catches anything visual
that no assertion describes.

## The trap that clouds every comparison: different CMS environments

Establish **before interpreting a single result** whether the builds are served the same
content. A QA build often points at a different CMS environment than production.
Consequences:

1. **Pixel diffs on content-heavy screens are advisory, not pass/fail.** A 43%
   difference on a screen is a promo card, not a regression.
2. **Never hard-assert CMS-driven labels.** A tile configured server-side fails against
   the other CMS for reasons unrelated to the code.

Cut through this with a **string-set comparison** instead of a pixel diff. The asymmetry
is the meaning:

- string in reference, **not** in candidate → real signal
- string only in candidate → newer CMS content

Cross-check every "missing" string against the APK string pool. If it is not there, it
is content, not a resource:

```bash
aapt2 dump strings base.apk | grep -F "the string"
```

`scripts/compare-text.py` does the comparison and, with `--apk`, the cross-check.

**Much visible text is not a string resource.** Menus, product names, opening hours and
listing rows often come from the backend. Asserting those tests the API, not your ticket. Tag such flows
`content`, not `strings`.

## Canaries for a changed translation pipeline

If the ticket changes how `strings.xml` is pulled or merged (Phrase, a merge, a module
move), the failure mode is **character corruption**. It shows only on non-ASCII
characters — every ASCII label keeps passing happily.

Find a handful of confirmed *local* resources with special characters and assert them
next to plain-ASCII labels from the same screen as a control group:

- `0–10 min` — U+2013 EN DASH
- `%s✓` — U+2713 CHECK MARK

If only the non-ASCII group fails, the string merge is the cause. If everything passes,
that is positive evidence rather than an absence of evidence.

## Scripts

In `scripts/`, project-agnostic. Copy them into the project's repo rather than running
them from the plugin, so the suite keeps working when the plugin changes.

- `find-tools.sh` — source it: `adb` and the newest `aapt2` on PATH
- `snapshot-resources.sh <apk|dir> <outdir>` / `--pull <appId> <outdir>` — layer 1, one build
- `compare-resources.sh <ref-dir> <cand-dir>` — layer 1, both directions, counts and values
- `logcat-scan.sh <appId> <outfile> [--duration S]` / `--scan <log>` — layer 3
- `compare-text.py <ref> <cand> [--apk ref.apk]` / `--capture out.txt` — the CMS string-set check
- `enum-clickable.py [--app <appId>]` — tappables and how they can be selected

## How to work

1. Establish what the ticket touches and derive the failure mode from it. State it
   explicitly before testing — the canaries follow from it.
2. Run the preflight, then install candidate + reference (+ cross-check) on one physical
   device and match their state.
3. Always run layers 1 and 3; they are cheap and catch the invisible.
4. Run layer 2 in full, layer 4 on the screens the ticket touches.
5. Read every difference first as an *environment or content difference* and only then
   as a regression. Write down explicitly what looks like a bug and isn't — that is as
   valuable as the findings themselves.

Don't pipe a long Maestro run through `tail` to watch it — it buffers and reports nothing
until the end, and hides the exit code. Write to a log file and read it.

Write up the result with the `qa-test-report` skill — by default the short Jira note.
