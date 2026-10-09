#!/bin/zsh
# build.sh — compile Grab.swift into a tiny ad-hoc-signed Grab.app (LSUIElement, with
# NSCameraUsageDescription) so macOS will grant it camera access to the iPhone capture source.
# Also compiles the helper CLIs sheet (contact sheets) and caption_ocr (Vision OCR) next to it;
# both run uncompiled too (`swift sheet.swift …`), just slower to start.
#
# qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
#
# Prerequisites: Xcode command-line tools (swiftc, codesign). No developer account needed.
# Usage:   ./build.sh [outDir]        default outDir: <this script's dir>/build
# Env:     GRAB_BUNDLE_ID             default local.qa.iphonegrab (camera approval is per bundle ID)
# Result:  <outDir>/Grab.app — run it through grab.sh / burst.sh (`open -a`), never directly;
#          <outDir>/sheet, <outDir>/caption_ocr — plain CLIs.
set -euo pipefail
HERE="${0:A:h}"
OUT="${1:-$HERE/build}"
OUT="${OUT:A}"
BUNDLE_ID="${GRAB_BUNDLE_ID:-local.qa.iphonegrab}"
APP="$OUT/Grab.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O "$HERE/Grab.swift" -o "$APP/Contents/MacOS/Grab"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>Grab</string>
  <key>CFBundleExecutable</key><string>Grab</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSCameraUsageDescription</key><string>Capture the connected iPhone screen for QA.</string>
</dict></plist>
PLIST
codesign --force --deep --sign - "$APP"
echo "built $APP"
for tool in sheet caption_ocr; do
    swiftc -O "$HERE/$tool.swift" -o "$OUT/$tool"
    echo "built $OUT/$tool"
done
