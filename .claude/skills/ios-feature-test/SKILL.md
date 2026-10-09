---
name: ios-feature-test
description: Test one iOS ticket or fix on an iPhone: checks from the ticket, the right build and flags, then VoiceOver, Dynamic Type, landscape, touch targets, contrast, offline, background refresh and PIN/OTP inputs. Use for "test ABC-123 on iOS", "test the new screen on the iPhone", "check VoiceOver", "does it work with larger text", "iOS accessibility test". Loads with ios-device-testing.
---

# Testing one iOS feature or ticket

The everyday iOS request: one ticket, one build, one phone, ending in a verdict on *this*
change. **How** to reach and drive the phone — the XCUITest driver, USB capture,
devicectl, crash logs — is `ios-device-testing`; load it alongside and do its pre-flight
first. This skill is **what** to check and how to judge it. Android is
`android-feature-test`.

## 1. Start from the ticket

As on the web (`web-feature-test` §1): get the ticket text, keep its acceptance criteria
in its own words and numbering, write down the failure mode the change invites and the
neighbours. Show the plan in the first reply as a **numbered case table** — one row per
criterion with *testable*, *N/A* or *not testable here*, and why. That table is where the
user corrects a misunderstanding for free, and it becomes the note.

iOS failure modes worth adding when the ticket touches them:

- **Labels, focus, announcements, a new screen or sheet** → VoiceOver (§4).
- **Text or layout** → Dynamic Type at the largest size *and* a middle one, landscape.
- **Colours, a theme, borders** → dark mode and measured contrast.
- **Small controls** → touch-target size, measured by tapping, not only from frames.
- **Network-dependent** → offline, the error's timing, recovery without touching the app.
- **Background work, widgets, Live Activities** → kill and relaunch, background refresh
  off, and every entry point (`live-activity-testing`).
- **iPad or Split View criteria** on an iPhone-only app → read `UIDeviceFamily` from the
  IPA's `Info.plist`. If the app doesn't support iPad, those criteria are *N/A — ask the
  product owner*, not FAIL.

## 2. Pin down what you're testing

- **The build.** Version *and* build number from `devicectl device info apps`, in every
  note. Re-read it whenever results change — TestFlight replaces builds mid-session
  (`ios-device-testing` pre-flight). If the IPA you were given and the phone disagree on
  the build number, ask the developers which one the ticket is about.
- **Is the change in it?** When the ticket removes or adds something you can't see —
  a framework, an entitlement, a string — check every Mach-O in the IPA (the app, its
  `PlugIns/`, its extensions) with `otool -L`, `nm -u` and `strings`, with a **positive
  control** each time (UIKit is linked; a known UI string is found). A crash report only
  lists the images on the stack, so it can't prove a framework is absent; the copy of an
  iPhone app in the Mac's `/Applications` is a placeholder without a binary.
- **Flags.** The Remote Config SQLite in the app container (`ios-device-testing`). A
  feature behind a flag that's off here is *not testable on this build*.
- **Config text vs built-in text.** If the ticket is about remotely configured strings,
  set a marker (`[QA]` prefix) in the config so you can tell which text came from where.
- **The device state** the ticket assumes — signed in, a managed or restricted mode,
  language — and the state the phone is actually in. Write both in the note.

## 3. Who drives what

- **Without VoiceOver:** the driver (`scripts/driver/up.sh`, `ios_driver.py`, `step.py`
  in `ios-device-testing`) for taps, the tree and screenshots.
- **With VoiceOver on:** the driver's taps and Back no longer work the way a user's do,
  and toggling VoiceOver drops the runner. **The user drives; you capture and judge.**
  One gesture per message, and say when you're capturing.
- **Capture until stopped, not for a fixed time.** `burst.sh --until-stop` and stop it
  when the user says "done" — fixed 90-second windows came back empty twice because the
  user wasn't ready.

**Three layers, and they disagree.** The XCUITest tree the driver reads, the
Accessibility Inspector, and what VoiceOver actually reaches and speaks are three
different things. A hidden PIN field showed its digits as a value in the tree while
VoiceOver never reached it, and the Inspector skipped it too. Name the layer behind every
accessibility verdict, and judge by the one the criterion is about — usually what a
VoiceOver user hears. "PASS for users, FAIL on the technical criterion" is a legitimate
result when the layers split; write it like that.

**Driver-only negatives are provisional.** "Can't scroll", "can't open", "off-screen",
"keyboard covers the field" from the driver were wrong five times in two sessions — the
user did it by hand. Until the user has confirmed it, it's *to check*, not FAIL (*The
verdict bar* in `qa-test-report`).

## 4. The conditions

| Condition | How | What breaks |
|---|---|---|
| VoiceOver | Accessibility Shortcut (triple-click the side button) → VoiceOver; Caption Panel on (Settings → Accessibility → VoiceOver) | focus lands on the wrong element, errors not announced, headings without the trait, secrets spoken |
| Dynamic Type | Settings → Accessibility → Display & Text Size → Larger Text → Larger Accessibility Sizes, slider to max; quicker: the Control Center *Text Size* control set to the app only | numbers and words broken mid-way, labels dropped, buttons pushed off-screen |
| Landscape | the driver's `orientation` command, or the user rotates | clipping, lost state, the wrong size class |
| Dark mode | Control Center or Settings → Display & Brightness | hard-coded colours, borders that vanish, images without a dark variant |
| Touch targets | `touch_targets.py`, then `hit_area.py` on the failures | controls smaller than 44×44 pt (24 pt with spacing) |
| Offline | Airplane Mode **and** Wi-Fi off — start the driver first | endless spinners, a dead end with no way back, a 30-second wait |
| Kill and relaunch | the user swipes the app away in the app switcher; or `devicectl device process launch --terminate-existing` | state that lived only in memory |
| Background refresh | Settings → Apps → the app → Background App Refresh off, as a control | work that only happens when the app is opened |
| Crash handling | `devicectl device process signal` with SIGABRT or SIGSEGV | no crash report, no recovery, a crash loop |
| Language | the phone's language (per-app language is often ignored); the *Preferred Language* row only shows if the app ships more than one | untranslated strings, truncation |
| Entry points | notification, Live Activity (compact, expanded, Lock Screen), widget, link — each from a fresh start *and* with the app last left on another screen | landing on the last screen instead of the target |

**Plan the user's toggles.** Changing system settings is the user's job: batch them
("turn on VoiceOver and the Caption Panel, then open the screen") and ask which value is
set — "largest standard size" and "largest accessibility size" got confused once.

**Before you test a condition, read its section in
[references/conditions.md](references/conditions.md)** — VoiceOver (speech capture, traits,
focus, secret input), Dynamic Type and layout, colour and contrast, offline, background and
crashes, touch targets. Each has the method that held up and what counted as a FAIL.

### Attempt-limited inputs

PIN, OTP and passcode fields usually lock after a few wrong tries, and every attempt is
real. **Read the field before typing** — if it doesn't say it's empty ("0 of 6"), stop:
leftover digits plus yours once completed a code and spent an attempt. Type at most one
digit fewer than the length unless the test is the submission itself. Ask before each
attempt that counts, and keep a running tally in the chat.

## 5. Reset everything

Before you finish, and say so: VoiceOver and the Caption Panel off, text size back,
appearance back, Zoom off, Airplane Mode and Wi-Fi back, Background App Refresh back, the
phone's language back, Auto-Lock back, the proxy off on every Wi-Fi network you set it on,
the mitmproxy profile removed if the phone is shared. A phone left at the largest text size
makes the next tester's screenshots wrong.

## 6. For a fix: see it fail first; for a finding: where does it not happen

As in `web-feature-test` §5–6. Reproduce the original issue on a build that still has it
before calling it fixed. Before writing a finding up, try the production build or the
previous release, and a second device or iOS version if there is one.

## 7. Close

- `qa-test-report`, short note by default, one per ticket (or one note for tickets the
  user asks to combine). *Tested on*: app version (build), TestFlight or not, device,
  iOS version and build, date, and the device state against the state the ticket
  assumes. Then *Tested*, *Not tested* with why, *Result*, and *Open* for the developers.
  A failed acceptance criterion is quoted word for word and leads.
- Each defect gets its own ticket via `bug-ticket`, with the layer it was seen in
  (driver tree, Inspector, VoiceOver) and the evidence (caption transcript, capture).
- If the screen gets tested at every release, offer to turn the automatable parts into a
  Maestro flow or a driver script in the project with `finding-to-test`.

## Scripts

Copy them into the project repo (the plugin cache path changes with every version). They
use `ios_driver.py` from `ios-device-testing/scripts/driver/` — copy that alongside.

- `scripts/layout_walk.py [--hierarchy F] [--tsv F]` — size class, clipped and truncated
  text, safe-area violations and overlaps on the current screen.
- `scripts/colorcount.swift <png> <#hex>... [--tol 12]` — pixel count and average colour
  per target colour; the loud-colour theme check.
- `scripts/contrast.swift <png> --y <row> [--scale 3]` — colour runs along a pixel row and
  the WCAG contrast between them.

From `ios-device-testing/scripts/`: `touch_targets.py`, `hit_area.py`, `step.py`,
`capture/burst.sh --until-stop`, `capture/caption_ocr.swift`, `ips.py`.
