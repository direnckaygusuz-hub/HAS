---
name: live-activity-testing
description: Test a push-driven live surface — iOS Live Activities, Android ongoing/live notifications, widgets, Dynamic Island — against a spec or TRD, including every state, the notification-permission matrix, and consistency with the in-app screen. Use for "test the Live Activity", "test the live notification", "does the tracker update", a TRD with states like pickup/arrived/unknown, or a notification-permission test.
---

# Live Activities and live notifications

A live surface is two things: **the app's own screen** (which reads the API) and **the
surface outside the app** (updated by push, or by the app in the background). They can
disagree, and the disagreement is usually the bug.

## Start by sorting the test cases

A ticket's case list usually mixes three kinds. Split them before testing and say which is
which:

1. **Client behaviour** — testable now on a device.
2. **The live surface** — testable only when the backend sends real updates (or on an
   Android build where the app posts the notification itself).
3. **Backend-only** — the subscription payload, push scheduling, cleanup. Testable by
   reading the traffic (does untrack send a `DELETE`? does the subscribe request carry the
   fields the spec names?), not by looking at the screen.

Number them (e.g. `TC-`, `S-` for subscription, `N-` for notification) and give every case
PASS / FAIL / *not testable* with a one-line reason.

## Every state, side by side

List the spec's states (for a delivery or vehicle tracker, e.g. *Arriving in X*, *At pick-up*,
*On the way*, *Arrived*, *Unknown*) and verify each on **both** surfaces **at the same instant** —
capture the app screen and the live surface together. A mismatch such as "`-`" on one and
"43 min" on the other, or a live surface frozen while the app moves on, is the finding.

Single screenshots miss short gaps. While a tracked item runs, poll both on a timer (every
30–45 s: the in-app card through the view hierarchy, the notification through `dumpsys
notification`, on iOS the Dynamic Island, Lock Screen and widgets through
`scripts/springboard_watch.py`) into one log with timestamps. That log showed the notification saying
*At pick-up* while the card still said *Pick up in 3 min*, and an ETA going back up from
*< 2 min* to *3 min*. Both are findings no screenshot pair would have caught.

To reach states the real world isn't in, use `mobile-network-injection` — but note that
push-driven surfaces won't follow injected data (see below). Check the spec's rules for the
empty state too: *Unknown* usually means no item and no progress bar.

## The notification-permission matrix (Android)

Test the feature in each permission state, and set the state deliberately:

| State | Set with |
|---|---|
| never asked | `pm revoke <pkg> android.permission.POST_NOTIFICATIONS` plus `pm clear-permission-flags <pkg> android.permission.POST_NOTIFICATIONS user-set user-fixed` (keeps the login) |
| denied | `pm revoke …` |
| granted | `pm grant …` |

Read the result from the *runtime permissions* block of `dumpsys package <pkg>`.

**Maestro's `launchApp` grants all permissions**, so run permission-prompt cases outside
Maestro — how, in `android-build-regression` (*Match the state of both builds*).

## Reading the notification (Android)

```bash
adb shell dumpsys notification --noredact | grep -A25 "AppSettings: <pkg>" | grep -oE "mId='[^']+'"
adb shell dumpsys notification --noredact | grep -A40 "channel=<channel>" | grep -oE "android\.(title|text|subText)=[^,]*"
```

Know which channels are the app's. Manufacturer and debug channels show up in the same
list — on Samsung, `rampart_*` belongs to the OS; `chucker_transactions` is the debug
network inspector. Reporting those as the app's notifications is an easy false finding.

**Attribute every notification to its package before reporting it.** With test,
acceptance and production builds on one phone, a build you aren't testing can be running
in the background and post into the same shade under the same app name. A debug-log
notification with an `UnknownHostException` for the *test* backend looked like a finding
for the acceptance build, but `NotificationRecord(… pkg=…)` showed it came from the test
build. On screen, the icon badge (TEST / ACC) gives it away.

**Android 16+ Live Updates** are promoted ongoing notifications, not a separate surface.
Look for `flags=…PROMOTED_ONGOING` and `android.template=…ProgressStyle`. The state is in
the extras: `android.title`, `android.text` (e.g. *Pick up in 2 min*), `android.subText`,
`android.progress` / `progressMax`, `progressSegments`, `progressPoints`. When the update
is push-driven, the first notification can take **30 s or more** after the user taps
Track. A check right after tracking finds nothing and reads as "no live notification",
so poll for at least a minute before concluding.

**A notification that disappears doesn't mean the user untracked.** `adb logcat -d -b
events | grep notification_canceled` logs every removal with a reason code. Reason `8` is
the app cancelling it itself. A dismissal or tap by the user has a different code. That's
how you tell "tracking ended by itself" from "someone touched the phone".

## Push is not injectable

An iOS Live Activity is updated by APNs pushes from the backend (to the activity's push
token). Rewriting the app's API responses moves the in-app screen but **not** the Live
Activity; forging a push needs the APNs key. So on iOS:

- test the states on the app screen with injected data,
- test the Live Activity with real data during operating hours,
- and say in the report which states were seen on the live surface with real data and
  which only in-app.

## Cleanup between sessions

Subscriptions outlive the test: if untrack doesn't send a `DELETE`, old subscriptions keep
posting updates into the next session and look like new bugs. Clear app data (Android
`pm clear`) or untrack everything between sessions, and note it — and report the missing
`DELETE` itself as a finding.

Analytics events for the feature (start, stop, tap on the live surface) are covered by
`mobile-app-analytics`.

## Scripts

Copy them into the project repo next to `ios-device-testing`'s `scripts/driver/` (the plugin
cache path changes with every version):

- `scripts/springboard_watch.py [--every 20] [--minutes 30 | --until HH:MM] [--match RE] [--app ID]
  [--log F] [--shots DIR] [--stop-on-change]` — iOS: polls SpringBoard through the XCUITest
  driver (Dynamic Island, Lock Screen / Notification Center, widgets, banners), drops the status
  bar and clock, and logs each change with a timestamp; `--app` logs the app's texts at the same
  instant. `--dump saved.json` shows how a saved tree is classified — check once on a new iOS.
