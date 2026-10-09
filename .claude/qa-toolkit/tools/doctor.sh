#!/usr/bin/env bash
# tools/doctor.sh — check the tools qa-toolkit's skills expect, and say how to fix what's
# missing. Read-only: it installs and changes nothing. Always exits 0.
#   bash tools/doctor.sh            (from the plugin, via /qa-doctor)
set -u

row() { printf '%-4s %-16s %-34s %s\n' "$1" "$2" "$3" "$4"; }
ver() { "$@" 2>/dev/null | head -1 | tr -d '\r' | cut -c1-34; }
check() {  # check <name> <binary> <used by> <fix> [version args...]
  local name=$1 bin=$2 used=$3 fix=$4; shift 4
  if command -v "$bin" >/dev/null 2>&1; then
    row "ok" "$name" "$( [ $# -gt 0 ] && ver "$bin" "$@" || echo found )" "$used"
  else
    row "--" "$name" "missing" "$used — $fix"
  fi
}

# adb often isn't on PATH but sits in the Android SDK — the same places find-tools.sh looks.
for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
  if [ -n "$sdk" ] && [ -x "$sdk/platform-tools/adb" ] && ! command -v adb >/dev/null 2>&1; then
    PATH="$sdk/platform-tools:$PATH"; adb_note="adb is in $sdk/platform-tools but not on your PATH — the Android scripts' find-tools.sh adds it."
  fi
done

echo "qa-toolkit doctor — $(date '+%Y-%m-%d %H:%M')"
echo
row "" "TOOL" "VERSION" "NEEDED FOR"
check node     node        "web scripts, Playwright"          "brew install node"                      --version
check python3  python3     "hooks, iOS and proxy scripts"     "xcode-select --install"                 --version
check gh       gh          "/qa-learn pull requests"          "brew install gh && gh auth login"       --version
check playwright-cli playwright-cli "quick browser looks"     "npm install -g @playwright/cli"         --version
check adb      adb         "Android skills"                   "brew install --cask android-platform-tools" version
check maestro  maestro     "Android/iOS flows"                "curl -fsSL https://get.maestro.mobile.dev | bash" --version
check mitmdump mitmdump    "mobile-network-injection"         "pipx install mitmproxy"                 --version
check xcrun    xcrun       "iOS device skills (devicectl)"    "install Xcode"                          --version
check swiftc   swiftc      "iOS capture, OCR, colour tools"   "install Xcode"                          --version

echo
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then echo "gh: signed in"; else echo "gh: not signed in — run: gh auth login"; fi
fi
if command -v npx >/dev/null 2>&1 && [ -f package.json ]; then
  pv=$(npx --no-install playwright --version 2>/dev/null | head -1)
  echo "Playwright in this project: ${pv:-not installed (npm i -D @playwright/test)}"
fi
[ -n "${adb_note:-}" ] && echo "$adb_note"
if command -v adb >/dev/null 2>&1; then
  n=$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device"' | wc -l | tr -d ' ')
  echo "Android devices connected: $n"
fi
if command -v xcrun >/dev/null 2>&1; then
  n=$(xcrun devicectl list devices 2>/dev/null | grep -ci 'connected' || true)
  echo "iOS devices connected: ${n:-0}"
fi
if command -v claude >/dev/null 2>&1; then
  inst=$(claude plugin list 2>/dev/null | grep -A2 'qa-toolkit@' | sed -n 's/.*Version: //p' | head -1)
  echo "qa-toolkit installed: ${inst:-unknown}"
fi
exit 0
