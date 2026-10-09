#!/usr/bin/env bash
# compare-resources.sh - compare two resource snapshots as sets, both ways (layer 1).
#
# What: reads two directories written by snapshot-resources.sh and reports
#   - counts per resource type and per file extension, so renamed or obfuscated
#     resources show up as "names differ, counts match" instead of as losses
#   - resource names, APK files and string-pool values present only in the
#     reference (the signal) and only in the candidate (usually debug tooling
#     or new content - reported, not failed)
#   - string resources whose name survived but whose VALUE changed
#   Everything is compared as sorted sets; resource order differs between builds.
#
# Prerequisites: bash, coreutils (comm, sort), awk. No device or SDK needed.
#
# Usage:
#   compare-resources.sh <ref-dir> <cand-dir> [--accept FILE] [--limit N]
#     --accept FILE  entries already investigated and accepted (one per line,
#                    '#' comments); matched exactly against names, file paths and
#                    string values, reported as ACCEPTED instead of failing
#     --limit N      max lines listed per section (default 40)
#   EXPECTED_EXTRAS  regex for candidate-only entries that are expected in a QA
#                    build (default: chucker, leakcanary, flipper, wood)
#
# Exit: 0 nothing lost, 1 something is only in the reference (review it), 2 usage.
set -uo pipefail

REF=""; CAND=""; ACCEPT=""; LIMIT=40
while [[ $# -gt 0 ]]; do
  case "$1" in
    --accept) ACCEPT="${2:?--accept needs a file}"; shift 2 ;;
    --limit)  LIMIT="${2:?--limit needs a number}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -uo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) if [[ -z "$REF" ]]; then REF="$1"; elif [[ -z "$CAND" ]]; then CAND="$1"
       else echo "unexpected argument: $1" >&2; exit 2; fi; shift ;;
  esac
done
[[ -n "$REF" && -n "$CAND" ]] || { echo "usage: compare-resources.sh <ref-dir> <cand-dir> [--accept FILE] [--limit N]" >&2; exit 2; }
for d in "$REF" "$CAND"; do
  [[ -f "$d/resources.txt" ]] || { echo "FAIL: $d is not a snapshot (no resources.txt) - run snapshot-resources.sh first" >&2; exit 2; }
done
EXPECTED_EXTRAS="${EXPECTED_EXTRAS:-chucker|leakcanary|flipper|(^|/)wood_}"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export LC_ALL=C
touch "$WORK/accepted"
[[ -n "$ACCEPT" ]] && grep -vE '^[[:space:]]*(#|$)' "$ACCEPT" | sort -u > "$WORK/accepted"

lines() { [[ -s "$1" ]] && wc -l < "$1" | tr -d ' ' || echo 0; }
file_or_empty() { if [[ -f "$1" ]]; then cat "$1"; fi; }
listing() {  # <file> <label>
  local n; n=$(lines "$1")
  [[ "$n" -eq 0 ]] && return
  head -n "$LIMIT" "$1" | sed "s/^/    $2 /"
  [[ "$n" -gt "$LIMIT" ]] && echo "    ... $((n - LIMIT)) more (--limit to see them)"
  return 0
}
# splits <only-in-ref> into unaccepted (stdout file $2) and accepted ($3)
split_accepted() {
  comm -23 "$1" "$WORK/accepted" > "$2"
  comm -12 "$1" "$WORK/accepted" > "$3"
}

lost=0
echo "=== static resource comparison ==="
label() {  # "com.example 1.2.3 (456)  <dir>" from the badging line in meta.txt
  local b; b=$(head -1 "$1/meta.txt" 2>/dev/null)
  echo "$(sed -nE "s/.*name='([^']*)'.*versionCode='([^']*)'.*versionName='([^']*)'.*/\1 \3 (\2)/p" <<< "$b")  $1"
}
echo "  reference : $(label "$REF")"
echo "  candidate : $(label "$CAND")"

# --- counts per type ------------------------------------------------------
echo
echo "--- counts per resource type (IDs; survives name obfuscation) ---"
counts() {  # <snapdir> -> type<TAB>n
  if [[ -f "$1/type-counts.txt" ]]; then cat "$1/type-counts.txt"
  else cut -d/ -f1 "$1/resources.txt" | sort | uniq -c | awk '{print $2 "\t" $1}'; fi
}
counts "$REF" | sort > "$WORK/tc_ref"; counts "$CAND" | sort > "$WORK/tc_cand"
join -t $'\t' -a1 -a2 -e 0 -o 0,1.2,2.2 "$WORK/tc_ref" "$WORK/tc_cand" \
  | awk -F'\t' 'BEGIN {printf "  %-14s %9s %9s %7s\n", "type", "reference", "candidate", "delta"}
                { d = $3 - $2; printf "  %-14s %9d %9d %+7d%s\n", $1, $2, $3, d, (d < 0 ? "   <- fewer in candidate" : "") }'

# --- resource names ---------------------------------------------------------
OBF=0
grep -q 'obfuscated' "$REF/resources.txt" "$CAND/resources.txt" && OBF=1
sort -u "$REF/resources.txt" > "$WORK/n_ref"; sort -u "$CAND/resources.txt" > "$WORK/n_cand"
comm -23 "$WORK/n_ref" "$WORK/n_cand" > "$WORK/n_only_ref_all"
comm -13 "$WORK/n_ref" "$WORK/n_cand" > "$WORK/n_only_cand"
split_accepted "$WORK/n_only_ref_all" "$WORK/n_only_ref" "$WORK/n_accepted"
grep -iE  "$EXPECTED_EXTRAS" "$WORK/n_only_cand" > "$WORK/n_extra_dbg" || true
grep -viE "$EXPECTED_EXTRAS" "$WORK/n_only_cand" > "$WORK/n_extra"     || true

echo
echo "--- resource names ---"
if [[ "$OBF" -eq 1 ]]; then
  echo "  names are collapsed/obfuscated in at least one build: name sets cannot be"
  echo "  compared. Use the per-type counts above and the string values below."
else
  printf "  only in reference : %5d   <- this is the signal\n" "$(lines "$WORK/n_only_ref")"
  printf "  only in candidate : %5d   (%d expected debug tooling)\n" \
    "$(( $(lines "$WORK/n_extra") + $(lines "$WORK/n_extra_dbg") ))" "$(lines "$WORK/n_extra_dbg")"
  listing "$WORK/n_only_ref" "MISSING "
  listing "$WORK/n_accepted" "ACCEPTED"
  listing "$WORK/n_extra"    "EXTRA   "
  [[ $(lines "$WORK/n_only_ref") -gt 0 ]] && lost=1
fi

# --- files in the APK (assets, fonts, drawables) -----------------------------
file_or_empty "$REF/files.txt"  | sort -u > "$WORK/f_ref"
file_or_empty "$CAND/files.txt" | sort -u > "$WORK/f_cand"
comm -23 "$WORK/f_ref" "$WORK/f_cand" > "$WORK/f_only_ref_all"
comm -13 "$WORK/f_ref" "$WORK/f_cand" > "$WORK/f_only_cand"
split_accepted "$WORK/f_only_ref_all" "$WORK/f_only_ref" "$WORK/f_accepted"

# bucket: assets/*.json, res/*.ttf, dex, lib/*.so ... (directory names dropped,
# because path shortening moves res/font/inter_bold.ttf to res/H8.ttf)
bucket() { awk '{ top = $0; sub(/\/.*/, "", top); ext = $0; sub(/.*\//, "", ext)
                  if (ext ~ /\./) { sub(/^[^.]*\./, "", ext) } else ext = "(none)"
                  if (top == $0) print "(root)." ext; else print top "/*." ext }' "$1" | sort | uniq -c | awk '{print $2 "\t" $1}'; }
bucket "$WORK/f_ref" > "$WORK/b_ref"; bucket "$WORK/f_cand" > "$WORK/b_cand"
bucket "$WORK/f_only_ref" > "$WORK/b_only_ref"; bucket "$WORK/f_only_cand" > "$WORK/b_only_cand"

echo
echo "--- files in the APK, by kind ---"
join -t $'\t' -a1 -a2 -e 0 -o 0,1.2,2.2 "$WORK/b_ref" "$WORK/b_cand" \
  | awk -F'\t' 'BEGIN {printf "  %-18s %9s %9s %7s\n", "kind", "reference", "candidate", "delta"}
                { d = $3 - $2; printf "  %-18s %9d %9d %+7d%s\n", $1, $2, $3, d, (d < 0 ? "   <- fewer in candidate" : "") }'

# per kind: res/ files missing by path but with a same-kind file new in the
# candidate are probably renamed (resource path shortening only touches res/);
# the rest, and anything outside res/, count as lost
join -t $'\t' -a1 -e 0 -o 0,1.2,2.2 "$WORK/b_only_ref" "$WORK/b_only_cand" \
  | awk -F'\t' '{ r = ($1 ~ /^res\// ? ($2 < $3 ? $2 : $3) : 0); renamed += r; gone += $2 - r }
                END { printf "%d %d\n", renamed, gone }' > "$WORK/f_split"
read -r F_RENAMED F_GONE < "$WORK/f_split"
printf "  only in reference : %5d   <- signal (%d probably renamed: same kind, same count; %d without a counterpart)\n" \
  "$(lines "$WORK/f_only_ref")" "${F_RENAMED:-0}" "${F_GONE:-0}"
printf "  only in candidate : %5d\n" "$(lines "$WORK/f_only_cand")"
listing "$WORK/f_only_ref"  "MISSING "
listing "$WORK/f_accepted"  "ACCEPTED"
listing "$WORK/f_only_cand" "EXTRA   "
[[ "${F_GONE:-0}" -gt 0 ]] && lost=1

# --- string values -----------------------------------------------------------
echo
echo "--- string values ---"
# same name + config, different value ("Order Online" -> "Shop Now")
if [[ "$OBF" -eq 0 && -f "$REF/string-values.tsv" && -f "$CAND/string-values.tsv" ]]; then
  awk -F'\t' 'NR == FNR { ref[$1 "\t" $2] = $3; next }
              (($1 "\t" $2) in ref) && ref[$1 "\t" $2] != $3 {
                printf "%s [%s]: \"%s\" -> \"%s\"\n", $1, $2, ref[$1 "\t" $2], $3 }' \
    "$REF/string-values.tsv" "$CAND/string-values.tsv" | sort > "$WORK/v_changed"
  printf "  changed value     : %5d   <- same name, different text\n" "$(lines "$WORK/v_changed")"
  listing "$WORK/v_changed" "CHANGED "
  [[ $(lines "$WORK/v_changed") -gt 0 ]] && lost=1
fi
# string pool as a set of values (file paths excluded - covered above)
file_or_empty "$REF/strings.txt"  | grep -v '^res/' | sort -u > "$WORK/s_ref"  || true
file_or_empty "$CAND/strings.txt" | grep -v '^res/' | sort -u > "$WORK/s_cand" || true
comm -23 "$WORK/s_ref" "$WORK/s_cand" > "$WORK/s_only_ref_all"
comm -13 "$WORK/s_ref" "$WORK/s_cand" > "$WORK/s_only_cand"
split_accepted "$WORK/s_only_ref_all" "$WORK/s_only_ref" "$WORK/s_accepted"
printf "  only in reference : %5d   <- signal: text the candidate no longer ships\n" "$(lines "$WORK/s_only_ref")"
printf "  only in candidate : %5d\n" "$(lines "$WORK/s_only_cand")"
listing "$WORK/s_only_ref"  "MISSING "
listing "$WORK/s_accepted"  "ACCEPTED"
listing "$WORK/s_only_cand" "EXTRA   "
[[ $(lines "$WORK/s_only_ref") -gt 0 ]] && lost=1

echo
if [[ "$lost" -eq 0 ]]; then
  echo "PASS: the candidate ships every resource, file and string value the reference ships"
  exit 0
fi
echo "REVIEW: something ships in the reference but not in the candidate (see <- signal above)."
echo "  Before calling it a bug, check whether any build - the reference included -"
echo "  actually reads it; removing unused resources may be exactly what the ticket did."
exit 1
