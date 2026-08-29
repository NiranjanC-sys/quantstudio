#!/usr/bin/env bash
# run.sh <label> <k6 script> [env assignments...]
#
# Wraps one k6 run with a sysmon sample stream so the latency numbers and the
# "which resource ran out" numbers come from the same wall-clock window.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
LABEL="$1"; shift
SCRIPT="$1"; shift
node tools/sysmon.mjs "$LABEL" > "results/${LABEL}-sysmon.log" 2>&1 &
MON=$!
trap 'kill $MON 2>/dev/null' EXIT
sleep 1
env "$@" RUN_LABEL="$LABEL" k6 run "$SCRIPT" 2>&1 | tee "results/${LABEL}-k6.txt"
RC=${PIPESTATUS[0]}
sleep 1
kill $MON 2>/dev/null
wait $MON 2>/dev/null
node tools/summarize.mjs "$LABEL"
exit $RC
