# shellcheck shell=bash
# find-tools.sh - put adb and the newest aapt2 on PATH for this shell.
#
# What: looks for the Android SDK (ANDROID_HOME, ANDROID_SDK_ROOT, then
#   ~/Library/Android/sdk on macOS and ~/Android/Sdk on Linux), prepends
#   platform-tools/ and the newest build-tools/<version>/ to PATH, and exports
#   ADB and AAPT2 with absolute paths. Tools already on PATH win.
#
# Prerequisites: an Android SDK with platform-tools (adb) and build-tools (aapt2).
#
# Usage (source it, don't execute it):
#   source scripts/find-tools.sh                  # needs adb and aapt2
#   FIND_TOOLS_NEED=aapt2 source scripts/find-tools.sh   # only aapt2 (no device work)
#   FIND_TOOLS_NEED= source scripts/find-tools.sh        # find what exists, require nothing
#
# Returns non-zero (without killing an interactive shell) when a needed tool
# is missing, and says where it looked.

_ft_sdk=""
for _ft_c in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" \
             "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
  if [[ -n "$_ft_c" && -d "$_ft_c" ]]; then _ft_sdk="$_ft_c"; break; fi
done

if [[ -n "$_ft_sdk" ]]; then
  if ! command -v adb >/dev/null 2>&1 && [[ -x "$_ft_sdk/platform-tools/adb" ]]; then
    PATH="$_ft_sdk/platform-tools:$PATH"
  fi
  if ! command -v aapt2 >/dev/null 2>&1; then
    # newest build-tools version that actually contains aapt2
    _ft_bt=$(for d in "$_ft_sdk"/build-tools/*/; do
               [[ -x "${d}aapt2" ]] && basename "$d"
             done | sort -V | tail -1)
    [[ -n "$_ft_bt" ]] && PATH="$_ft_sdk/build-tools/$_ft_bt:$PATH"
  fi
  export PATH
fi

ADB="$(command -v adb 2>/dev/null || true)"
AAPT2="$(command -v aapt2 2>/dev/null || true)"
export ADB AAPT2

_ft_rc=0
for _ft_t in ${FIND_TOOLS_NEED-adb aapt2}; do
  if ! command -v "$_ft_t" >/dev/null 2>&1; then
    echo "find-tools: '$_ft_t' not found." >&2
    echo "  looked on PATH and in: ${_ft_sdk:-<no SDK found; set ANDROID_HOME>}" >&2
    case "$_ft_t" in
      adb)   echo "  install: Android Studio > SDK Manager > SDK Tools > Android SDK Platform-Tools" >&2 ;;
      aapt2) echo "  install: Android Studio > SDK Manager > SDK Tools > Android SDK Build-Tools" >&2 ;;
    esac
    _ft_rc=1
  fi
done

unset _ft_sdk _ft_c _ft_bt _ft_t
if [[ "$_ft_rc" -ne 0 ]]; then unset _ft_rc; return 1 2>/dev/null || exit 1; fi
unset _ft_rc
