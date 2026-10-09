#!/usr/bin/env bash
# snapshot-resources.sh - record the static resource manifest of one build (layer 1).
#
# What: dumps what an APK ships into plain, sorted text files, so two builds can
#   be compared as sets with compare-resources.sh:
#     meta.txt           package, versionName/Code, source APK(s), sha256
#     resources.txt      every resource as type/name (strings, drawables, fonts, ...)
#     type-counts.txt    type <TAB> number of resource IDs (survives name obfuscation)
#     string-values.tsv  string/<name> <TAB> config <TAB> value
#     strings.txt        the resource string pool (aapt2 dump strings), one per line
#     files.txt          every file in the APK (assets/, res/, ...), META-INF excluded
#   Values are recorded as well as names: a string whose text changed passes a
#   name-only diff.
#
# Prerequisites: aapt2 and unzip; adb only for --pull. find-tools.sh (next to this
#   script) is sourced to find them.
#
# Usage:
#   snapshot-resources.sh <apk | dir-of-apks> <outdir>
#   snapshot-resources.sh --pull <appId> <outdir>    # pull the installed APK(s) first
#
#   A Play-installed app is split: base.apk plus split_config.*.apk (densities,
#   languages). Pass the directory holding all of them (or use --pull, which pulls
#   every split) so the snapshot covers the whole install.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2; }

PULL_APP=""
if [[ "${1:-}" == "--pull" ]]; then
  [[ $# -eq 3 ]] || usage
  PULL_APP="$2"; OUT="$3"
  FIND_TOOLS_NEED="adb aapt2 unzip"
else
  [[ $# -eq 2 ]] || usage
  SRC="$1"; OUT="$2"
  FIND_TOOLS_NEED="aapt2 unzip"
fi
# shellcheck source=find-tools.sh
source "$HERE/find-tools.sh" || exit 2

mkdir -p "$OUT"

if [[ -n "$PULL_APP" ]]; then
  SRC="$OUT/apk"; mkdir -p "$SRC"
  paths=$(adb shell pm path "$PULL_APP" 2>/dev/null | tr -d '\r' | sed -n 's/^package://p')
  [[ -n "$paths" ]] || { echo "FAIL: $PULL_APP is not installed on the device" >&2; exit 2; }
  while IFS= read -r p; do
    adb pull "$p" "$SRC/$(basename "$p")" >/dev/null \
      || { echo "FAIL: could not pull $p" >&2; exit 2; }
  done <<< "$paths"
fi

APKS=()
if [[ -d "$SRC" ]]; then
  for f in "$SRC"/*.apk; do [[ -f "$f" ]] && APKS+=("$f"); done
else
  [[ -f "$SRC" ]] && APKS=("$SRC")
fi
[[ ${#APKS[@]} -gt 0 ]] || { echo "FAIL: no APK at $SRC" >&2; exit 2; }

# base.apk first, so the badging in meta.txt comes from it
BASE="${APKS[0]}"
for f in "${APKS[@]}"; do [[ "$(basename "$f")" == "base.apk" ]] && BASE="$f"; done

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

for apk in "${APKS[@]}"; do
  aapt2 dump resources "$apk" 2>/dev/null >> "$WORK/resources.dump" \
    || echo "warn: aapt2 dump resources failed for $(basename "$apk")" >&2
  aapt2 dump strings "$apk" 2>/dev/null >> "$WORK/strings.dump" || true
  unzip -Z1 "$apk" >> "$WORK/files.raw" 2>/dev/null || true
done

# type/name for every resource line: "    resource 0x7f020001 string/eta"
grep -E '^[[:space:]]*resource 0x[0-9a-f]+ ' "$WORK/resources.dump" \
  | sed -E 's/^[[:space:]]*resource 0x[0-9a-f]+ //; s/[[:space:]].*$//' \
  | LC_ALL=C sort -u > "$OUT/resources.txt" || true

# counts per type, unique by resource ID: an obfuscated build collapses every
# name to one placeholder, so names alone would under-count
grep -oE '^[[:space:]]*resource 0x[0-9a-f]+ [^/[:space:]]+' "$WORK/resources.dump" \
  | awk '{print $2 "\t" $3}' | LC_ALL=C sort -u \
  | awk -F'\t' '{n[$2]++} END {for (t in n) printf "%s\t%d\n", t, n[t]}' \
  | LC_ALL=C sort > "$OUT/type-counts.txt" || true

# string values: the value lines follow their resource line, e.g.
#       () "Order Online"        (de) "Online bestellen"
awk '
  /^[[:space:]]*resource 0x[0-9a-f]+ / {
    split($3, tn, "/"); cur = (tn[1] == "string") ? $3 : ""; next
  }
  cur != "" && /^[[:space:]]*\(/ {
    line = $0; sub(/^[[:space:]]*\(/, "", line)
    cfg = line; sub(/\).*$/, "", cfg); if (cfg == "") cfg = "default"
    val = line; sub(/^[^)]*\)[[:space:]]*/, "", val)
    if (val ~ /^".*"$/) val = substr(val, 2, length(val) - 2)
    gsub(/\t/, "\\t", val)
    printf "%s\t%s\t%s\n", cur, cfg, val
  }
' "$WORK/resources.dump" | LC_ALL=C sort -u > "$OUT/string-values.tsv"

# string pool: "String #12 : Order Online"
sed -n 's/^String #[0-9]* : //p' "$WORK/strings.dump" | LC_ALL=C sort -u > "$OUT/strings.txt"

grep -v '^META-INF/' "$WORK/files.raw" | LC_ALL=C sort -u > "$OUT/files.txt" || true

{
  aapt2 dump badging "$BASE" 2>/dev/null | grep -m1 '^package:' || echo "package: <unknown>"
  for apk in "${APKS[@]}"; do
    echo "apk: $(basename "$apk") sha256=$({ shasum -a 256 "$apk" 2>/dev/null || sha256sum "$apk"; } | cut -d' ' -f1)"
  done
  echo "snapshot: $(date '+%Y-%m-%d %H:%M:%S')"
} > "$OUT/meta.txt"

count() { wc -l < "$1" | tr -d ' '; }
echo "snapshot : $OUT"
sed -n '1p' "$OUT/meta.txt" | sed 's/^/  /'
echo "  resources $(count "$OUT/resources.txt"), string values $(count "$OUT/string-values.tsv"), pool strings $(count "$OUT/strings.txt"), files $(count "$OUT/files.txt")"
if grep -q 'obfuscated' "$OUT/resources.txt"; then
  echo "  note: resource names are collapsed/obfuscated in this build - compare counts, not names"
fi
