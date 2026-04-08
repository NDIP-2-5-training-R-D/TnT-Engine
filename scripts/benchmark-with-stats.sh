#!/usr/bin/env bash

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is required"
  exit 1
fi

if ! command -v awk >/dev/null 2>&1; then
  echo "ERROR: awk is required"
  exit 1
fi

BASE_URL="${1:-http://localhost:8000}"
TEST_TYPE="${2:-baseline}"
INTERVAL_SECONDS="${3:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${REPO_ROOT}/tmp/benchmark-stats"
mkdir -p "${OUTPUT_DIR}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${OUTPUT_DIR}/${TEST_TYPE}-${TIMESTAMP}.log"
SUMMARY_FILE="${OUTPUT_DIR}/${TEST_TYPE}-${TIMESTAMP}-summary.txt"

SERVICES=(
  "tnt-engine"
  "openbao"
  "postgres"
  "redis"
)

declare -A PEAK_CPU
declare -A PEAK_MEM_MIB
declare -A PEAK_MEM_PCT

for service in "${SERVICES[@]}"; do
  PEAK_CPU["${service}"]=0
  PEAK_MEM_MIB["${service}"]=0
  PEAK_MEM_PCT["${service}"]=0
done

resolve_container_name() {
  local service="$1"
  docker ps \
    --filter "label=com.docker.compose.service=${service}" \
    --format '{{.Names}}' | head -n 1
}

to_mib() {
  local raw="$1"
  local value unit
  value="$(echo "${raw}" | sed -E 's/^([0-9.]+).*/\1/')"
  unit="$(echo "${raw}" | sed -E 's/^[0-9.]+([a-zA-Z]+)$/\1/')"

  case "${unit}" in
    B) awk -v v="${value}" 'BEGIN { printf "%.4f", v / 1024 / 1024 }' ;;
    KiB|kB) awk -v v="${value}" 'BEGIN { printf "%.4f", v / 1024 }' ;;
    MiB|MB) awk -v v="${value}" 'BEGIN { printf "%.4f", v }' ;;
    GiB|GB) awk -v v="${value}" 'BEGIN { printf "%.4f", v * 1024 }' ;;
    TiB|TB) awk -v v="${value}" 'BEGIN { printf "%.4f", v * 1024 * 1024 }' ;;
    *) echo "0" ;;
  esac
}

sample_stats() {
  local service="$1"
  local container_name
  local line cpu mem_usage mem_pct mem_used mem_used_mib

  container_name="$(resolve_container_name "${service}")"
  [[ -z "${container_name}" ]] && return 0

  line="$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}' "${container_name}" 2>/dev/null | head -n 1 || true)"
  [[ -z "${line}" ]] && return 0

  cpu="$(echo "${line}" | cut -d'|' -f2 | tr -d '%')"
  mem_usage="$(echo "${line}" | cut -d'|' -f3)"
  mem_pct="$(echo "${line}" | cut -d'|' -f4 | tr -d '%')"
  mem_used="$(echo "${mem_usage}" | cut -d'/' -f1 | xargs)"
  mem_used_mib="$(to_mib "${mem_used}")"

  if awk -v a="${cpu:-0}" -v b="${PEAK_CPU[${service}]}" 'BEGIN { exit !(a > b) }'; then
    PEAK_CPU["${service}"]="${cpu:-0}"
  fi

  if awk -v a="${mem_used_mib:-0}" -v b="${PEAK_MEM_MIB[${service}]}" 'BEGIN { exit !(a > b) }'; then
    PEAK_MEM_MIB["${service}"]="${mem_used_mib:-0}"
  fi

  if awk -v a="${mem_pct:-0}" -v b="${PEAK_MEM_PCT[${service}]}" 'BEGIN { exit !(a > b) }'; then
    PEAK_MEM_PCT["${service}"]="${mem_pct:-0}"
  fi

  printf '%s | %s\n' "$(date '+%F %T')" "${line}" >> "${LOG_FILE}"
}

monitor_loop() {
  while true; do
    for service in "${SERVICES[@]}"; do
      sample_stats "${service}"
    done
    sleep "${INTERVAL_SECONDS}"
  done
}

echo "=== Benchmark with Docker stats ==="
echo "Base URL: ${BASE_URL}"
echo "Test:     ${TEST_TYPE}"
echo "Interval: ${INTERVAL_SECONDS}s"
echo "Log:      ${LOG_FILE}"
echo ""

monitor_loop &
MONITOR_PID=$!

cleanup() {
  if kill -0 "${MONITOR_PID}" >/dev/null 2>&1; then
    kill "${MONITOR_PID}" >/dev/null 2>&1 || true
    wait "${MONITOR_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT

bash "${REPO_ROOT}/scripts/load-test.sh" "${BASE_URL}" "${TEST_TYPE}"

cleanup
trap - EXIT

while IFS='|' read -r name cpu mem_usage mem_pct; do
  [[ -z "${name:-}" || -z "${cpu:-}" || -z "${mem_usage:-}" || -z "${mem_pct:-}" ]] && continue

  service=""
  for candidate in "${SERVICES[@]}"; do
    if [[ "${name}" == *"${candidate}"* ]]; then
      service="${candidate}"
      break
    fi
  done
  [[ -z "${service}" ]] && continue

  cpu="$(echo "${cpu}" | tr -d '%[:space:]')"
  mem_pct="$(echo "${mem_pct}" | tr -d '%[:space:]')"
  mem_used="$(echo "${mem_usage}" | cut -d'/' -f1 | xargs)"
  mem_used_mib="$(to_mib "${mem_used}")"

  if awk -v a="${cpu:-0}" -v b="${PEAK_CPU[${service}]}" 'BEGIN { exit !(a > b) }'; then
    PEAK_CPU["${service}"]="${cpu:-0}"
  fi

  if awk -v a="${mem_used_mib:-0}" -v b="${PEAK_MEM_MIB[${service}]}" 'BEGIN { exit !(a > b) }'; then
    PEAK_MEM_MIB["${service}"]="${mem_used_mib:-0}"
  fi

  if awk -v a="${mem_pct:-0}" -v b="${PEAK_MEM_PCT[${service}]}" 'BEGIN { exit !(a > b) }'; then
    PEAK_MEM_PCT["${service}"]="${mem_pct:-0}"
  fi
done < <(awk -F' \\| ' '{print $2}' "${LOG_FILE}")

{
  echo "=== Peak Docker stats summary ==="
  echo "Test: ${TEST_TYPE}"
  echo "Timestamp: ${TIMESTAMP}"
  echo ""
  for service in "${SERVICES[@]}"; do
    printf '%s\n' "${service}"
    printf '  Peak CPU: %s%%\n' "${PEAK_CPU[${service}]}"
    printf '  Peak Mem: %s MiB\n' "${PEAK_MEM_MIB[${service}]}"
    printf '  Peak Mem%%: %s%%\n' "${PEAK_MEM_PCT[${service}]}"
    echo ""
  done
} | tee "${SUMMARY_FILE}"

echo "Summary saved to ${SUMMARY_FILE}"
