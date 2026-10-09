# iOS device testing — one-time setup

Read from the `ios-device-testing` skill when the USB capture tool or Maestro's XCUITest
driver isn't set up yet on this Mac. Using them is in the skill itself.

## USB capture tool

- Enable screen-capture devices through CoreMediaIO
  (`kCMIOHardwarePropertyAllowScreenCaptureDevices = 1`), then discover with
  `AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: nil, …)` —
  **`nil`, not `.video`**: the iPhone is a muxed audio/video source and `.video` hides it.
  Skip the Mac's own FaceTime camera.
- macOS denies camera access to a bare CLI launched from an agent. Wrap it in a tiny `.app`
  with `NSCameraUsageDescription` and `LSUIElement` in `Info.plist`, ad-hoc sign it
  (`codesign --force --deep --sign -`), and run it with `open -a`. The user approves the
  camera prompt once.
  `scripts/capture/build.sh` does all of this; `grab.sh` / `burst.sh` run it.

## XCUITest driver

The driver is an XCUITest runner app that Maestro installs on the phone. Getting it
built, signed and started:

- **Signing.** The user signs in to Xcode *and* creates the certificate (Accounts →
  Manage Certificates → + → Apple Development) — signing in alone creates none. You never
  type their Apple ID. A personal team works; its profiles expire after 7 days.
- **The packaged driver may not build.** Maestro 2.10's jar ships the driver project
  without its `MaestroDriverLib/` sources, so `maestro driver-setup` fails whatever the
  signing. Sparse-clone `maestro-ios-xctest-runner` from the official repo at the tag
  matching `maestro --version`, and `xcodebuild build-for-testing` it yourself into the
  folder Maestro reads (`~/.maestro/maestro-iphoneos-driver-build/driver-iphoneos`, plus a
  `version.properties` with `version=<x.y.z>`). Downloading source is the user's call — ask.
- **Build settings** via `XCODE_XCCONFIG_FILE`: `IPHONEOS_DEPLOYMENT_TARGET = 15.0` (Xcode 27
  rejects the driver's 14.0), a bundle ID unique to the team
  (`com.<you>.qa.$(TARGET_NAME:rfc1034identifier)` — the stock `dev.mobile.*` IDs belong to
  another team), `DEVELOPMENT_TEAM`. Build once with `-destination id=<udid>
  -allowProvisioningDeviceRegistration`: a build for `generic/platform=iphoneos` fails with
  "your team has no devices".
- **Trust the developer** on the phone (Settings → General → VPN & Device Management) —
  the user does that; until then the driver installs but never starts.
- **Starting it** is `scripts/driver/up.sh` from then on. Under the hood:
  `TEST_RUNNER_PORT=<port> xcodebuild test-without-building -xctestrun <build>/Build/Products/*.xctestrun
  -destination id=<udid>` plus `usbfwd.py --udid <udid> <port>`. Point `DRIVER_BUILD` at the build
  folder when it isn't `~/.maestro/maestro-iphoneos-driver-build/`.
