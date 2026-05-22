#!/usr/bin/env bash
# Resurrect-on-death cron for BIT crawls (PARALLEL CHUNKED VERSION).
# Designed to be triggered by launchd every 5 minutes.
#
# Architecture: 5 chunks per platform × 2 platforms = 10 parallel watchdogs.
# Each chunk has its own keywords file (outputs/bit/chunks/chunk-N.txt) and
# its own watchdog process. All chunks share the same output dir per platform.
#
# For each chunk-platform pair:
#   1. Skip if its watchdog process is alive
#   2. Skip if all its keywords' output files are complete (>= 100 posts each)
#   3. Otherwise → respawn watchdog (detached via nohup+disown)
#
# Logs every action to logs/bit_resurrect.log (with timestamps).
set -u

PROJECT_DIR="/Users/geolex/Documents/高频意图爬取+/-twitter-reddit"
CHUNKS_DIR="${PROJECT_DIR}/outputs/bit/chunks"
RESURRECT_LOG="${PROJECT_DIR}/logs/bit_resurrect.log"
N_CHUNKS=5

cd "${PROJECT_DIR}" || exit 1

if [[ ! -d "${CHUNKS_DIR}" ]]; then
  echo "$(date '+%F %T') [resurrect] chunks dir missing: ${CHUNKS_DIR} — aborting" >> "${RESURRECT_LOG}"
  exit 1
fi

# Helper: slugify a keyword the same way scripts/utils.mjs does
slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g'
}

for platform in twitter reddit; do
  output_dir="outputs/bit/${platform}"
  batch_script="scripts/run_${platform}_keyword_batch.mjs"
  mkdir -p "${output_dir}"

  for chunk_idx in $(seq 1 "${N_CHUNKS}"); do
    chunk_file="${CHUNKS_DIR}/chunk-${chunk_idx}.txt"
    log_file="logs/bit_${platform}_chunk${chunk_idx}.log"
    pgrep_pattern="run_batch_with_watchdog.*chunk-${chunk_idx}.txt.*${output_dir}"

    # 1. Is this chunk's watchdog already alive?
    if pgrep -f "${pgrep_pattern}" > /dev/null; then
      continue
    fi

    # 2. Are all keywords in this chunk already complete OR ceiling-marked?
    state_file="${output_dir}/_retry_state.json"
    all_done=1
    while IFS= read -r kw; do
      [[ -z "${kw}" ]] && continue
      slug=$(slugify "${kw}")
      output_file="${output_dir}/${slug}.json"

      # Check retry state first — keywords marked "ceiling" or "complete" are accepted as done
      if [[ -f "${state_file}" ]]; then
        # Pass the keyword via env var to avoid quoting/escaping hell
        kw_status=$(KW="${kw}" STATE_FILE="${state_file}" node -e '
          try {
            const s = JSON.parse(require("fs").readFileSync(process.env.STATE_FILE, "utf8"));
            console.log(s[process.env.KW]?.status || "pending");
          } catch(e) { console.log("pending"); }
        ' 2>/dev/null || echo pending)
        if [[ "${kw_status}" = "ceiling" ]] || [[ "${kw_status}" = "complete" ]]; then
          continue  # this keyword finalized — no need to crawl again
        fi
      fi

      if [[ ! -f "${output_file}" ]]; then
        all_done=0
        break
      fi
      # Check post count
      count=$(node -e "
        try {
          const p = JSON.parse(require('fs').readFileSync('${output_file}', 'utf8'));
          const n = p.posts?.length ?? p.stats?.parent_posts ?? (p.items?.filter(i=>i.record_type==='reddit_post').length||0);
          console.log(n);
        } catch(e) { console.log(0); }
      " 2>/dev/null || echo 0)
      if [[ "${count}" -lt 100 ]]; then
        all_done=0
        break
      fi
    done < "${chunk_file}"

    if [[ "${all_done}" -eq 1 ]]; then
      continue
    fi

    # 3. Respawn this chunk's watchdog, fully detached
    echo "$(date '+%F %T') [resurrect] ${platform} chunk-${chunk_idx}: watchdog dead → respawning" >> "${RESURRECT_LOG}"
    nohup bash -c "scripts/run_batch_with_watchdog.sh ${batch_script} --keywords-file ${chunk_file} --output-dir ${output_dir}" \
      >> "${log_file}" 2>&1 < /dev/null &
    disown 2>/dev/null || true
  done
done
