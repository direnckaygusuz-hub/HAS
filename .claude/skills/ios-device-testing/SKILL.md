---
name: ios-device-testing
description: Reach and drive a physical iPhone from a Mac, including TestFlight builds: Maestro's XCUITest driver, USB screen capture, devicectl for app data, flags and crash logs, or splitting the taps with the user. Use for "test this on the iPhone", "test the iOS app", TestFlight builds, Dynamic Island, or when Maestro can't find the iOS device.
---

# iOS on a physical device

This skill is the mechanics: reaching, driving and reading the phone. For **what** to
check on a ticket — VoiceOver, Dynamic Type, landscape, contrast, offline, background —
load `ios-feature-test` alongside.

## Decide the approach first — it isn't Android

State this in the first reply, before trying anything:

- **Maestro can drive a physical iPhone** — including a TestFlight build — once its
  XCUITest driver is signed and running on the phone (see *Driving the real phone* below).
  Trap: this skill used to say "simulators only", and a whole session went into
  human-driven taps before the user pointed out they had seen it work. Check for an
  Apple Development certificate (`security find-identity -p codesigning`) and a previous
  `~/.maestro/maestro-iphoneos-driver-build/` before concluding it can't be done.
- **A simulator build** (an `.app` built for the simulator, or the source) is still the
  easiest route when the team can provide one: no signing, and Maestro works fully.
- Only when neither is available is the test **human-driven with machine verification**:
  the user taps, and you capture, read and judge.

Also check the hardware against the test cases: Dynamic Island cases need an iPhone 14
Pro or later. A notch phone can only show the Lock Screen / Notification Center variants —
mark the island cases *not testable on this device*, not failed. A Live Activity,
Dynamic Island or widget ticket also needs `live-activity-testing` — load it alongside
this one.

## Pre-flight — before the first test case

Each of these cost a session at least once, always halfway through:

- **TestFlight → the app → Automatic Updates off.** TestFlight updated the build under
  test mid-session twice — once to a build that crashed on launch, so the user had to
  downgrade. **Re-read the installed build** (`devicectl device info apps`) at the start
  of every test block, and put that build in the note.
- **Auto-Lock → Never.** A phone that locks stops the capture and the driver; both
  captures of a 90-second window came back empty.
- **USB connected**, not only paired over Wi-Fi — usbmux can't forward to a Wi-Fi phone.
- **Settings → Developer → Enable UI Automation** on. Without it the driver fails with
  "Timed out while enabling automation mode".
- **Start the driver while the phone is online** and not yet behind a proxy (see *Driving
  the real phone*).

## What you can read without driving the UI

`xcrun devicectl` covers a lot:

```bash
xcrun devicectl list devices                                  # paired? connected?
xcrun devicectl device info apps --device <id> --include-all-apps  # installed builds
xcrun devicectl device copy from --device <id> \
  --domain-type appDataContainer --domain-identifier <bundleId> \
  --source "Library/Application Support/Google/RemoteConfig" --destination rc/
```

The Firebase Remote Config SQLite (`sqlite3 rc/RemoteConfig.sqlite3`, tables `main`,
`main_active`, `main_default`) shows the **fetched flag values and the app's compiled-in
defaults** — the fastest way to settle "is this feature on for this build".

**Pick the build by bundle ID and read its flags before planning.** Test, acceptance and
production builds often share one name on the home screen, and a "final build" can be
the production bundle, which runs on live backends and live flags. Two of five focus
features were switched off in production Remote Config. Reading the flags first decided
what could be tested at all, and the flag-off state turned out to be a test case of its
own: the one crash of the session happened only with the Live Activity flag **off**. So
run each gated feature in the flag state the build will ship with, and mark "flag on"
behaviour *not testable on this build* rather than failed.

Not available without extra setup: device console logs (`log collect` needs root), and
driving the UI (see below).

## Crash logs

A crash leaves a `.ips` report on the phone, and you can pull it without Xcode:

```bash
xcrun devicectl device info files --device <id> --domain-type systemCrashLogs | grep "<Executable>"
xcrun devicectl device copy from --device <id> --domain-type systemCrashLogs \
  --source "Retired/<Executable>-<date>.ips" --destination ./crash.ips
```

Reports are named after the **executable** (`CFBundleExecutable`), not the home-screen
name, and the two often differ — a search for the display name once came back "no
crashes" while reports were there. Read the executable from the app's `Info.plist`
(`plutil -extract CFBundleExecutable raw Payload/*.app/Info.plist` from the `.ipa`), or
list every report from today and check the bundle ID in each header line.

Recent reports move to `Retired/` quickly, so list that too. The first line of the file is
a JSON header (bundle ID, app and build version, OS). The rest is one JSON object: read
`exception`, `asi`, `faultingThread`, and the frames of that thread against `usedImages`
(`scripts/ips.py` prints all of that).
A production build is unsymbolicated, so report the app-image offsets and ask the devs to
symbolicate with the dSYM. Reproduce once and compare the stacks: identical frames show
the crash is deterministic. Then run the same steps on another build (for example
acceptance), which tells the devs whether a config or flag difference is the trigger.
Answer the "Share with developer?" prompt with the privacy-preserving choice.

## Seeing the screen: USB capture

A connected, unlocked iPhone is exposed to macOS as a capture device (the same mechanism
QuickTime uses). A small Swift tool can grab a frame from it:

- **Building the capture tool** (CoreMediaIO, the `.app` wrapper for camera access) is in
  [references/setup.md](references/setup.md#usb-capture-tool); `scripts/capture/build.sh`
  builds it. If the project repo already has one, use it.
- The phone must stay **unlocked** (Auto-Lock → Never during the test). A locked phone
  stops publishing the capture source. The Lock Screen itself can't be captured; Notification
  Center shows the same Live Activity and can.
- The capture source only delivers a frame **when the screen changes** — a still screen
  gives one frame, then nothing. That makes a "burst" mode (save a frame at most every N
  seconds for T seconds, `scripts/capture/burst.sh`) cheap: the user does a short sequence
  of taps and you get one frame per step with no idle duplicates. It also means a burst of a static screen ends
  with one file, not a failure.
- **When the user drives, don't guess the length.** A fixed 60-second burst missed what
  the user did after it ran out. Run `burst.sh --until-stop` in the background and touch
  its stop file when they say "done".
- Keep the tool **in the project repo**. A rig built in a scratch directory is gone next
  session and costs an hour to rebuild.

## Driving the real phone: Maestro's XCUITest driver

The driver is an XCUITest runner app that Maestro installs on the phone; it serves an
HTTP API (`status`, `viewHierarchy`, `touch`, `swipe`, `inputText`, `launchApp`,
`terminateApp`, `pressButton`, `screenshot`) on a port *on the device*. Each trap below cost
real time:

- **One-time setup** — the Apple Development certificate, building the driver yourself
  when Maestro's packaged one doesn't build, the build settings, trusting the developer
  on the phone — is in [references/setup.md](references/setup.md#xcuitest-driver). Check
  for `~/.maestro/maestro-iphoneos-driver-build/` first; if it's there, skip to
  `scripts/driver/up.sh`.
- **Start and restart it with `up.sh`, not by hand.** It starts the one
  `xcodebuild test-without-building` runner plus the forwarder in the background, waits for
  `/status`, and reuses them when they are healthy. The runner was restarted about a
  hundred times by hand in two sessions. When it fails, `up.sh` reads the runner log and
  names the cause: phone locked, offline or behind a proxy, *Enable UI Automation* off, no
  USB, a profile that doesn't include this phone. It only stops what it started itself, and
  it names whoever else holds the port — once a forwarder left over from another project.
- **The port lives on the phone.** Nothing reaches it until you forward it over USB. A
  forwarder that talks to `/var/run/usbmuxd` needs only the standard library — but **look
  up the usbmux DeviceID on every connection**: it changes whenever the phone
  re-enumerates, and a cached ID gives "connection reset" that looks exactly like a
  driver that never started. Probe `curl 127.0.0.1:<port>/status` → `{"status":"ok"}`
  before blaming anything else. `scripts/driver/usbfwd.py` does this (`--list` shows what
  usbmuxd sees; a Wi-Fi-paired phone is listed but can't be forwarded); `up.sh` runs it.
- **The Maestro CLI's real-device path is rough** (2.10): `launchApp` is "not yet
  implemented" (cold-start with `xcrun devicectl device process launch
  --terminate-existing`), `test` picks a random driver port unless you pass
  `--driver-host-port`, and every run starts its own `xcodebuild` runner — leftover runners
  knock each other off the phone. Driving the driver's HTTP API directly from a small
  client with **one** runner you started yourself was far more reliable than `maestro test`
  — `scripts/driver/ios_driver.py` is that client.
- **"Developer App Certificate is not trusted" usually means offline.** iOS checks the
  developer certificate online when the runner starts. A phone in airplane mode, or one
  behind mitmproxy that intercepts Apple's hosts, gives exactly this error — on a phone
  where it worked minutes ago. Start the runner *before* going offline, and pass Apple's
  hosts through the proxy (`mobile-network-injection`, iOS). Toggling VoiceOver or
  rotating can also drop the runner: run `up.sh` after either (a no-op when it's healthy).
- **Third-party helpers** such as `maestro-ios-device setup` download patched jars and
  *replace* Maestro's own — don't run them without the user's explicit OK; the forwarder
  above is all they add.
- **Reading the hierarchy.** Paged views (carousels, tabs) keep copies of their elements
  off-screen — filter to the visible frame before tapping. Take the screen size from the
  application element: the root is 0x0, in landscape too. Drop the status bar — a walk
  tapped its "◀ <other app>" back link and left the app. Match exact labels before
  substrings ("Close" otherwise hits "Closed"), and remember identifiers collide with
  labels (a Search tab with identifier `map` beats the *Map* row). A long list can take
  over a minute to serialise — raise the client timeout rather than assume the app hung;
  check the app's process ID with devicectl to rule out a crash.
- **"Can't scroll / can't tap" from the driver is not a finding yet.** In landscape and
  with the keyboard up, synthetic swipes and taps miss what a finger reaches. Three
  driver-only negatives were written into notes and were wrong: the user scrolled to the
  field by hand. Before a driver-only negative goes in a note, ask the user to try it by
  hand while you capture. Until then it is *not verified* (*The verdict bar* in
  `qa-test-report`).
- **System prompts are yours to answer.** Location, camera and notification permission
  dialogs appear in the hierarchy; pick the most privacy-preserving option unless the case
  needs another, and say which you chose.

## Splitting the work with the user

When the driver isn't set up, the user does the taps; make each one cheap:

- **One step per message**, phrased as an action and a stopping point: "Tap *Track* on
  the first item, then stop." Not a list of eight steps.
- Say **when you're capturing** ("tap it now — I'm capturing for 10 seconds").
- After each "done", verify it yourself (capture, proxy log, remote config) and say what
  you saw in one line before asking for the next step.
- Batch the questions you need answered by eye (e.g. haptics, sound) into one message at
  the end.

## Traffic and data

Use `mobile-network-injection` for proxy setup on iOS (Wi-Fi proxy plus the *Certificate
Trust Settings* step). Remember that anything updated **by push** — Live Activities,
widgets, notifications — isn't moved by rewriting API responses; only a real backend
push changes it. See `live-activity-testing`.

## In the report

Header: device model, iOS version, build and bundle ID, and **how it was driven** —
automated through the driver, human-driven with captured evidence, or which parts were
which. Mark every case that couldn't be run on this
hardware or without a simulator build as *not testable*, with the reason.

## Scripts

Copy them into the project repo (the plugin cache path changes with every version) and run from there.
Each header names the plugin version it came from — compare an old copy with the plugin's before
trusting it. Ports, bundle IDs and UDIDs are arguments or env vars (`IOS_DRIVER_PORT`, `IOS_APP_ID`,
`IOS_UDID`), never edits to the script.

- `scripts/capture/build.sh [outDir]` — builds the ad-hoc-signed `Grab.app` plus the `sheet` and
  `caption_ocr` CLIs (default `capture/build/`).
- `scripts/capture/grab.sh <out.png>` — one frame. `burst.sh <dir> <everySec> <forSec>` — burst;
  `burst.sh --until-stop <dir> <everySec>` runs until `<dir>/frame.stop` exists or Ctrl-C.
- `scripts/capture/sheet.swift <dir>/frame` — contact sheets of a burst (AppKit only; `swift sheet.swift …`).
- `scripts/capture/caption_ocr.swift [--changes] <dir>/frame-*.png` — OCR of the VoiceOver Caption
  Panel strip: a transcript of what VoiceOver spoke during a burst.
- `scripts/driver/up.sh [--udid U] [--port P]`, `up.sh status`, `up.sh down` — runner + forwarder.
- `scripts/driver/usbfwd.py [--udid U] 22087` — usbmux forwarder; `--list` shows devices.
- `scripts/driver/ios_driver.py status|tree|tap <label>|orientation <o>|screenshot <f>` — driver
  client, importable.
- `scripts/driver/step.py <name> tap <label>` — act, save `evidence/<name>.png`, print the tree.
- `scripts/driver/touch_targets.py [--screen N --tsv F]` — 44 pt / 24 pt check of the current screen.
- `scripts/driver/hit_area.py <label>` — taps around a small target to see whether it reacts
  outside its frame (it taps: never on call, pay or submit).
- `scripts/ips.py <crash.ips>...` — header, exception, faulting stack; says whether several match.
