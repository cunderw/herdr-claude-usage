#!/bin/sh
# The mod's only reader of transcripts. Two commands:
#   scan.sh list <projects dir> <minutes> [session id...]
#     size and path of every transcript written in the last <minutes>, and of
#     every file (main and subagents/) of the named sessions.
#   scan.sh read <scan.awk> <path> <offset> <size> [<path> <offset> <size>...]
#     the usage records in bytes offset..size of each file, after a "#file" line.
set -f  # session patterns below must reach find unexpanded
cmd=$1; shift
case $cmd in
list)
  root=$1; mins=$2; shift 2
  [ -d "$root" ] || exit 0
  set -- "$root" -name '*.jsonl' -type f '(' -mmin "-$mins" $(for s in "$@"; do printf ' -o -path */%s.jsonl -o -path */%s/subagents/*' "$s" "$s"; done) ')' -exec wc -c '{}' +
  find "$@" 2>/dev/null
  ;;
read)
  awkf=$1; shift
  while [ $# -ge 3 ]; do
    f=$1; off=$2; size=$3; shift 3
    printf '#file\t%s\n' "$f"
    tail -c "+$((off + 1))" "$f" | head -c "$((size - off))" | LC_ALL=C awk -v limit="$((size - off))" -f "$awkf"
  done
  ;;
esac
