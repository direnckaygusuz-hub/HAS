---
name: mobile-app-analytics
description: Verify the analytics events a native Android or iOS app sends (Firebase / GA4 for apps) against a tracking plan or ticket — capturing events from the device, checking parameters, and forcing the app states that trigger them. Use for "check the app events", "does the app send X", "test the analytics of this feature on Android/iOS", Firebase DebugView, or an analytics section in a mobile test report.
---

# Mobile app analytics

The web version of this work is `tracking-plan-audit`. The plan, the gate column and the
"what counts as missing" rules are the same; what differs is how you see the events.

## Capture on Android

Turn on Firebase's debug channel for the app under test, and make the Firebase tags
verbose:

```bash
adb shell setprop debug.firebase.analytics.app <appId>
adb shell setprop log.tag.FA VERBOSE
adb shell setprop log.tag.FA-SVC VERBOSE
adb logcat -v time -s FA FA-SVC > fa.log
```

`FA-SVC: Logging event:` lines carry the event name and the full parameter bundle. Events
also appear live in Firebase **DebugView** if someone has console access, but the log is
enough and needs no account.

**Cross-read with the app's own logger.** Many apps log each tracking call themselves
(on Android often a Timber-based tracking logger). If the app's log and the `FA-SVC`
bundle agree, the event is proven. If the app logs a call that Firebase never logs, the
event is dropped between the two — that is a different bug from "never called".

Switch it off afterwards so the device doesn't keep sending debug traffic:

```bash
adb shell setprop debug.firebase.analytics.app .none.
```

## Capture on iOS

**Look for the app's own debug menu first.** QA and TestFlight builds often hide one behind
a shake gesture or a long press on the logo — a *Build info* screen with switches such as
"Show Firebase logging" and a network viewer. The Firebase switch typically turns on a
floating event list (name, time, parameters). Trap: earlier sessions concluded iOS events
were unreachable without Xcode because no one asked; the user found the overlay by shaking
the phone. Ask "does the build have a debug or shake menu?" in the first reply.

- With the driver from `ios-device-testing` running, the overlay is in the accessibility
  tree, so each event reads as one text line (`screen_view, 16:22:19, screen_class: …`).
  Tap, read the overlay, compare — no screenshots or OCR needed. Without the driver,
  capture it over USB and read the screenshots.
- It shows what the app **hands to the Firebase SDK**, not what reaches Firebase: consent
  gating, sampling or SDK drops after that point are invisible. Say so in the report, and
  use DebugView when that distinction matters.
- Leave the other debug actions alone (clearing stored bookings, erasing the local CMS
  cache) unless the test needs them — they change state for the next tester.

Otherwise: launch with `-FIRDebugEnabled` (from Xcode, or a scheme the developers provide)
and read the device console. On a physical device without Xcode that often isn't possible
from the command line — say so early, and ask for a debug build or DebugView access rather
than spending the session on it. See `ios-device-testing`.

## Forcing the states that fire events

Most events fire only in a particular state: an order on its way, a booking in progress,
a notification being tapped. When the real world isn't in that state (outside operating
hours, no live data), replay or inject the backend responses — see
`mobile-network-injection`. Write down in the report that the data was injected; the
event is still real.

## Verifying parameters

- **Check the value, not just the key.** For each parameter: what the plan specifies,
  what was observed, and whether it matches. A table per event works best.
- **Test ambiguous values experimentally.** An `Occupancy=0` with `load 0 / capacity 25`
  doesn't tell you whether the field is a percentage or a count. Inject `load 10 /
  capacity 25`: `40` means percentage, `10` means raw count. The same trick works for
  prices (cents vs units), durations (seconds vs minutes) and indexes (0- vs 1-based).
- **Check every surface the plan names.** An action that can be done from two screens
  must be verified from both; the `ga_screen` / `_sn` parameter tells you which one fired.
- **Say "never emitted" only after searching the whole log** for the name, and any part of
  it, across the whole run. Note that the *feature* worked (the
  notification was posted, the deep link opened) — an event missing while the feature
  works is an instrumentation bug, not a feature bug.
- **Character differences are findings or not, explicitly.** A `·` in the app where the
  plan writes `-` is worth one line in the report, with your judgement on whether it
  breaks the dashboard.

## Report

A summary table first — event, fires?, parameters `n / m`, verdict (PASS / PARTIAL /
FAIL) — then one section per event with the captured payload verbatim. Header: build,
device and OS version, date and time with timezone, capture method, and whether data was
injected. Write it up with `qa-test-report`.
