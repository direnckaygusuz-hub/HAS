---
name: android-feature-test
description: Test one Android ticket or fix on a device or emulator: checks from the ticket, the right build and flags, then rotation, font size, dark mode, process death, offline and deep links. Use for "test this ticket on Android", "verify the fix on the Pixel", "retest ABC-123 on Android", or any Android test that isn't a refactor regression against a reference build.
---

# Testing one Android feature or ticket

The everyday mobile request: one ticket, one build, one device. Not the four-layer
comparison for a "nothing should change" refactor (`android-build-regression`) — a
focused test that ends in a verdict on *this* change. iOS is `ios-feature-test`.

## 1. Start from the ticket

Same as on the web (`web-feature-test` §1): get the ticket text, and before touching
the device write down the acceptance criteria, the failure mode the change invites, and
the neighbours (other screens using the same component, endpoint or string). Show that
list in the first reply — it's the test plan.

Android-specific failure modes worth adding when the ticket touches them:

- **A new screen or state** → rotation and process death (does the state survive?).
- **Text or layout** → largest font size, a long translation, a small screen.
- **Colours or images** → dark mode.
- **Anything reached from outside the app** (notification, link, widget) → a cold start
  from that entry point, not just the in-app path.
- **Network-dependent** → offline and slow responses, and the error state.

## 2. Pin down what you're testing

Do the preflight in `android-build-regression` first (adb, authorisation, one Maestro
client per device). Then:

- **Which build.** `adb shell dumpsys package <appId> | grep versionName` — compare with
  the ticket. Test, acceptance and production variants often sit side by side with the
  same launcher name; use the app ID, not the icon.
- **Does it contain the change?** The version the fix shipped in, or the build number
  from the ticket or CI. Testing a build without the fix produces a confident "not fixed".
- **Flags.** On a debuggable build, read Remote Config from the app's data
  (`run-as <appId>`). On a release-type build you can't; infer the flag from the UI and
  say in the report that it was inferred. A feature behind a flag that is off here is
  *not testable on this build*, not failed.
- **Start state.** Signed in or out, first-run prompts dismissed, permissions as the
  case needs them — see *Match the state* in `android-build-regression`, including why
  Maestro's `launchApp` is wrong for permission tests.
- **The clock** for anything time-dependent (opening hours, timetables): the phone's
  timezone vs the backend's (`mobile-network-injection` has the check).

## 3. Drive it

- **Exploring:** the Maestro MCP (`inspect_screen`, then short inline flows with `run`)
  or `maestro studio`. Read the view hierarchy, not screenshots, to decide what to tap;
  take screenshots as evidence.
- **Ad-hoc `adb input`:** check the app is in front before every tap
  (`android-build-regression` explains why).
- **Logcat, scoped to the app's UID,** running for the whole session — a feature that
  looks right can still log a missing resource or a swallowed exception. Crashes:
  `adb logcat -b crash`.
- **Don't submit anything real** — orders, bookings, feedback, messages — without asking
  first, with what exactly will be sent. Close rating prompts without answering.

Hand off where another skill fits: sign-in or payment → `authenticated-testing`,
analytics events → `mobile-app-analytics`, a live notification → `live-activity-testing`,
a backend state you can't get → `mobile-network-injection`.

## 4. The device conditions

For each criterion, the happy path, the edges from step 1, and then the conditions that
apply to the change:

| Condition | How | What breaks |
|---|---|---|
| Rotation | `adb shell settings put system accelerometer_rotation 0`, then `adb shell settings put system user_rotation 1` (back to 0, and auto-rotate back on, afterwards) | lost input, duplicated fragments, clipped layouts |
| Process death | background the app, `adb shell am kill <appId>`, reopen from recents | state that only lived in memory; a blank or reset screen |
| Largest font | `adb shell settings put system font_scale 1.3` (up to 2.0 on newer Android) | truncated labels, overlapping text, buttons pushed off-screen |
| Dark mode | `adb shell cmd uimode night yes` | hard-coded colours, dark-on-dark text, images without a dark variant |
| Small screen | `adb shell wm size 720x1280` and `wm density 320` | content that needs a scroll that isn't there |
| Offline | ask the user to switch on airplane mode (it can cut an adb-over-Wi-Fi connection) | endless spinners, a crash instead of an error state |
| Deep link | `adb shell am start -a android.intent.action.VIEW -d "<uri>" <appId>` with the app killed first | a cold start that skips setup, a link that lands on the home screen |
| Back | system back and the gesture from each new screen | leaving the app, losing a form, a loop between two screens |
| Locale | a language with non-ASCII characters and long words, if the app has one | encoding, truncation (see the canaries in `android-build-regression`) |

"Don't keep activities" (Developer options) is a cheaper stand-in for process death
across the whole session if the change is about state.

**Reset everything you changed** before you finish, and say so: rotation, font scale,
night mode, `wm size reset`, `wm density reset`, Developer options, airplane mode. A
phone left at font scale 1.3 and 720×1280 makes the next tester's screenshots wrong.

## 5. For a fix: see it fail first

As in `web-feature-test` §5: reproduce the original bug on a build that still has it
(production, the previous release) before confirming it's gone on the fixed build. "Could
not reproduce the original issue" is a different verdict from "fixed".

## 6. For a finding: where does it *not* happen

Before writing it up, try it on the production build (or the previous release) and, if
you have one, a second device or Android version. "Only on the candidate", "already on
production" and "only on Android 13" are different tickets. Check logcat and the crash
buffer for the moment it happened — the stack trace is usually the finding.

## 7. Close

- Write it up with `qa-test-report` — by default the short Jira note. Header: build and
  app ID, device model, Android version, and which conditions from §4 you ran.
- Each defect gets its own ticket via `bug-ticket`.
- Say what you did **not** test (other devices and OS versions, signed-in states, other
  locales, the conditions from §4 you skipped).
- If the check is worth repeating, offer to turn it into a Maestro flow in the project's
  suite with `finding-to-test` — tagged, linked to the ticket, and made to fail once.
