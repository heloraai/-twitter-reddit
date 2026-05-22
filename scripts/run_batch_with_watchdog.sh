#!/usr/bin/env bash
# Watchdog wrapper for batch crawl scripts.
# Automatically restarts the batch script if it dies (SIGKILL, OOM, harness kill, etc.).
# The batch script's own "skip-if-complete" logic resumes from where it left off.
#
# Usage:
#   scripts/run_batch_with_watchdog.sh <batch_script> [batch_args...]
#
# Examples:
#   scripts/run_batch_with_watchdog.sh scripts/run_twitter_keyword_batch.mjs \
#       --keywords-file outputs/bit/keywords.txt --output-dir outputs/bit/twitter
#
# To fully detach from the parent shell / harness, prefix with nohup + setsid:
#   nohup setsid scripts/run_batch_with_watchdog.sh ... > logs/x.log 2>&1 < /dev/null &
#
# Environment:
#   MAX_RESTARTS  default 10  — give up after N restarts in a row
#   RESTART_DELAY default 30  — seconds to wait after a crash before restarting
#   WATCHDOG_LOG  default /dev/stderr — where to write watchdog meta-messages

set -u

BATCH_SCRIPT="${1:-}"
if [[ -z "${BATCH_SCRIPT}" ]]; then
  echo "[watchdog] ERROR: no batch script provided" >&2
  echo "Usage: $0 <batch_script> [args...]" >&2
  exit 2
fi
shift

MAX_RESTARTS="${MAX_RESTARTS:-10}"
RESTART_DELAY="${RESTART_DELAY:-30}"
WATCHDOG_LOG="${WATCHDOG_LOG:-/dev/stderr}"

restart=0
while (( restart < MAX_RESTARTS )); do
  echo "[watchdog] $(date '+%F %T') attempt $((restart+1))/${MAX_RESTARTS}: node ${BATCH_SCRIPT} $*" | tee -a "${WATCHDOG_LOG}"
  node "${BATCH_SCRIPT}" "$@"
  rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "[watchdog] $(date '+%F %T') batch exited cleanly (rc=0). Done." | tee -a "${WATCHDOG_LOG}"
    exit 0
  fi
  echo "[watchdog] $(date '+%F %T') batch died with rc=${rc} (likely SIGKILL/OOM). Restarting in ${RESTART_DELAY}s..." | tee -a "${WATCHDOG_LOG}"
  restart=$((restart+1))
  sleep "${RESTART_DELAY}"
done

echo "[watchdog] $(date '+%F %T') gave up after ${MAX_RESTARTS} restarts." | tee -a "${WATCHDOG_LOG}"
exit 1
