---
name: mobile-network-injection
description: Intercept, record, replay and rewrite a mobile app's API traffic with mitmproxy on an Android or iOS device, to test states the backend isn't in right now. Use for "set up a proxy on the phone", "force this state", "there's no live data", "replay yesterday's responses", mitmproxy, or a feature that only works at certain hours.
---

# Mobile network injection with mitmproxy

For a **website**, you don't need a proxy: Playwright's `page.route` / `route.fulfill` (or
`playwright-cli route`) rewrites responses inside the test browser. See
`web-environment-matrix`. This skill is for native apps on a device.

When the feature depends on live backend data — vehicles on a route, a delivery status, a
queue time, stock levels — the real world is often not in the state you need. Recording real responses
and rewriting them on the way to the app lets you test every state at any hour.

**Before anything else, check the clock.** Compare the phone's timezone with the
backend's (`adb shell getprop persist.sys.timezone` vs `TZ=<backend zone> date`) and the
service's operating hours. "No data" at 03:00 local backend time is not a bug. Half a
session was once spent on a phone set to European time testing a US service before it
opened.

## Setup

Install once: `pipx install mitmproxy`. Run `mitmdump` once to generate the CA in
`~/.mitmproxy/`. Start it in the background, with the addon and a capture file:

```bash
nohup mitmdump --listen-port 8080 -s inject.py -w run.mitm > mitmdump.log 2>&1 &
lsof -nP -iTCP:8080 -sTCP:LISTEN     # listening?
```

Stop it with `kill $(lsof -ti tcp:8080)`. `scripts/run.sh [port]` does the start and the
check, and prints the stop command.

**Read the capture, not the log.** Under `nohup`, `mitmdump.log` is block-buffered and can
look empty while traffic flows. Check what arrived with
`mitmdump -nr run.mitm --set flow_detail=1` (or the injector's own log).

### Android — route over USB, not Wi-Fi

Corporate Wi-Fi usually isolates devices from each other, so the phone can't reach the
Mac's IP. Tunnel over USB instead:

```bash
adb reverse tcp:8080 tcp:8080
adb shell settings put global http_proxy 127.0.0.1:8080
```

**Install the CA as a user certificate — from inside Settings.** Push the file to
`/sdcard/Download/`, then have the user go to the CA-certificate installer in Settings
(search "CA certificate"; the path differs per manufacturer) → *Install anyway* → pick the
file. Shortcuts via intents or `am start` are blocked on current Android. The phone needs
a screen lock. The step people miss is the file picker after *Install anyway*; verify under
*Trusted credentials → User*.

Check the build trusts user CAs at all: `aapt2 dump xmltree base.apk --file
AndroidManifest.xml | grep networkSecurityConfig`. Release builds usually don't; QA builds
usually do. Handshake failures for Google system services are expected — they only trust
system CAs.

### iOS — Wi-Fi proxy and two trust steps

1. Settings → Wi-Fi → ⓘ → Configure Proxy → Manual → `<Mac IP>:8080` (on Wi-Fi, not
   cellular). Re-read the Mac's IP with `ipconfig getifaddr en0` right before telling the
   user — it changes between sessions.
2. Safari → `http://mitm.it` → download the iOS profile.
3. Settings → General → VPN & Device Management → install it.
4. **Settings → General → About → Certificate Trust Settings → enable mitmproxy.** This
   is the step people skip; without it every HTTPS call fails.

Traps on iOS:

- **"Trusted" is a claim; a decrypted HTTPS flow is proof.** The user said the
  certificate was trusted and the switch in step 4 was off. Before testing, look for at
  least one HTTPS request to the app's backend in the capture with its response body.
- **The proxy setting is per Wi-Fi network.** It applies only to the network it was set
  on, and a phone that roams to another network silently leaves the proxy. Note every
  network you configured, and clean up each one.
- **Don't assume the network isolates devices — test it.** Open `http://mitm.it` on the
  phone: the mitmproxy page means the phone reaches the Mac. A guest network the user
  needed turned out to work fine after Claude had assumed it wouldn't. Only when the test
  fails, use another network (a hotspot from the Mac, a separate test network).
- **Let Apple's hosts through when the phone also runs the XCUITest driver.** iOS checks
  the developer certificate online; with those hosts intercepted, the driver fails with
  "Developer App Certificate is not trusted" (see `ios-device-testing`). Pass them
  through:

  ```bash
  scripts/run.sh 8080 --ignore-hosts '(^|\.)(apple\.com|icloud\.com|mzstatic\.com|cdn-apple\.com)(:[0-9]+)?$'
  ```

### Launch order

Proxy up → certificate trusted → **then cold-launch the app.** Apps cache the network
setup at launch; an app started before the proxy shows "Network error" and keeps doing so.
Android: `am force-stop <appId>` then launch. iOS: the user force-quits and reopens.

## Record, then replay

Record during a window when the backend has real data (`-w flows.mitm`), and save the
relevant responses as fixtures (one JSON file per endpoint), with a small script using
`mitmproxy.io.FlowReader` — `mitmdump -nr flows.mitm -s scripts/extract_fixtures.py`
writes the latest real body per rule and skips responses the addon rewrote. Read a capture with
`mitmdump -nr flows.mitm --set flow_detail=3 "~u <path>"`.

On replay, **refresh the timestamps** (`receiveTime`, `updatedAt`, …) to now, or the app
drops the data as stale.

## The injector addon

A `response(flow)` hook that only touches the endpoints you care about
(`scripts/inject.py`), driven by a small **control file** it re-reads on every flow:

```json
{ "mode": "arriving", "minutes": 6, "replay": true, "itemId": "…" }
```

A shell helper (`scripts/setstate.sh <mode> [key=value ...]`) writes the file, so switching state
during a test is one command, and `{"mode": "off", "replay": false}` returns to live data.
Log every rewrite to a file — when a screen looks wrong, the log tells you whether your
rewrite ran. Wait at least one app poll interval after switching before judging the screen.

Rules learned by breaking them:

- **A capture records what the app received, not what the backend sent.** `-w` saves the
  body *after* your addon rewrote it, so fixtures cut from a test session contain your
  fake data. Mark rewritten flows (`flow.comment`) and skip them when extracting — or
  record with the injector off.
- **Replay from the `request` hook, not `response`.** Answering in `response` still needs
  the real backend to be up; replay is usually needed exactly when it isn't. Serve the
  fixture in `request` and apply the mode's rewrite afterwards.

- **Find out which field the app actually reads.** Rewriting an ETA field changed nothing
  because the status came from a per-item array of upcoming steps. Change one field at
  a time and watch the screen.
- **Order and position carry meaning.** If the app picks "the next stop" by position in an
  array, you advance a trip by *removing* the entries in front, not by changing minutes.
  Keep arrays in their real chronological order; appending out of order produces nonsense
  states.
- **Synthesize missing entries by cloning a real one** and changing its IDs — the upstream
  feed often omits items that are too far ahead.
- **Some states latch.** After a bad payload the app may stay in a terminal state until the
  subscription is recreated (untrack and re-track).
- **Hard-coded clock offsets rot.** If the addon converts times between zones, derive the
  offset from the backend zone, don't hard-code it — daylight saving will break it.
- **Push-driven surfaces can't be injected.** A widget, notification or Live Activity
  updated by push (APNs / FCM from the backend) doesn't read your proxied response. The
  proxy moves the in-app screen only. Say so in the report instead of reporting the widget
  as frozen.

In-app network inspectors (Chucker) only see the HTTP client they are wired into — often
OkHttp but not a Ktor client. Use the proxy as the source of truth.

## Cleanup — always, and before handing the phone back

A global proxy left pointing at a proxy that is no longer running **cuts all internet on
the phone** — the user then can't even reinstall the app.

```bash
adb shell settings put global http_proxy :0
adb reverse --remove tcp:8080
kill $(lsof -ti tcp:8080)
```

`scripts/cleanup-android.sh [port]` does all three, and still stops the listener without adb.

iOS: Wi-Fi proxy back to Off **on every network you set it on**; remove the profile if
the device is shared. Tell the user
explicitly that cleanup is done.

Keep the addon, helpers and fixtures **in the project repo**, not in a scratch directory —
a rig kept in a scratchpad is gone by the next session.

## Scripts

A project-agnostic kit in `scripts/`. Copy it into the project repo and edit only the
`RULES` section of `inject.py`; the example rule there is a fake API to replace.

- `inject.py` — the addon: rules, fixture replay, timestamp refresh, clone and backend-clock helpers, one log line per rewrite.
- `setstate.sh` — writes the control file atomically; `setstate.sh off` is live data.
- `run.sh` — starts mitmdump with the addon and a capture file, checks the port.
- `extract_fixtures.py` — capture to `fixtures/<rule>.json`; run it through `mitmdump -nr … -s`.
- `cleanup-android.sh` — proxy reset, `adb reverse` removal, listener stopped.

## In the report

State that data was injected or replayed, from when the fixtures were recorded, and which
states were forced. An injected state is a real test of the client; it is not a test of
the backend.
