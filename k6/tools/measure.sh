#!/usr/bin/env bash
# One k6 read measurement of GET /api/v1/villages, always with the same procedure.
#
# Usage (from anywhere): k6/tools/measure.sh <label> <date> "<code description>"
#   label: free text used in the file names, e.g. before | after-indexes | after-union
#   date:  e.g. 2026-11-23
#   code description: copied into the result header (which code and which indexes this run has)
#
# Steps: recreate the app container, ANALYZE, totals check, quiet-machine gate, 15 s warm-up
# (discarded), 60 s measured with 20 virtual users. Results go to k6/results/<date>-<label>-20k.{json,txt}
# and k6/results/<date>-totals-<label>.txt.
#
# Quiet-machine gate: the machine is sampled for 30 s (average CPU, lowest free RAM). If CPU is above
# MAX_CPU or free RAM is below MIN_RAM_MB it waits a minute and checks again, up to MAX_WAIT_MIN minutes,
# then gives up (exit 3) without measuring.
#
# Environment (all optional):
#   MAX_CPU (20), MIN_RAM_MB (650), MAX_WAIT_MIN (10)  the gate
#   K6_NETWORK       Docker network of the Compose project (default: <project folder>_default)
#   WATCH_PROCESSES  space-separated process names to count in the result header (default: "chrome msedge")
#   POSTGRES_USER, POSTGRES_DB  read from .env when not set (default: qaryati)
#
# Needs: the Compose stack running with RATE_LIMIT_ENABLED=false, the perf data loaded (npm run perf:data),
# Docker, Node, and a Windows (PowerShell) or Linux (/proc) host. The Linux sampling is untested.
set -euo pipefail

LABEL="${1:?usage: measure.sh <label> <date> \"<code description>\"}"
DATE="${2:?usage: measure.sh <label> <date> \"<code description>\"}"
CODE="${3:?usage: measure.sh <label> <date> \"<code description>\"}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

MAX_CPU="${MAX_CPU:-20}"
MIN_RAM_MB="${MIN_RAM_MB:-650}"
MAX_WAIT_MIN="${MAX_WAIT_MIN:-10}"
WATCH_PROCESSES="${WATCH_PROCESSES:-chrome msedge}"
K6_NETWORK="${K6_NETWORK:-$(basename "$ROOT" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9_-')_default}"

env_value() { [ -f .env ] && grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
PGUSER="${POSTGRES_USER:-$(env_value POSTGRES_USER)}"; PGUSER="${PGUSER:-qaryati}"
PGDATABASE="${POSTGRES_DB:-$(env_value POSTGRES_DB)}"; PGDATABASE="${PGDATABASE:-qaryati}"
psql_q() { docker compose exec -T postgres psql -U "$PGUSER" -d "$PGDATABASE" -tAc "$1"; }

# The k6 container mounts the k6/ folder; on Git Bash the Docker daemon needs the Windows form of the path.
K6_DIR="$( (cd k6 && pwd -W 2>/dev/null) || (cd k6 && pwd) )"

OUT="k6/results/${DATE}-${LABEL}-20k"
TOTALS="k6/results/${DATE}-totals-${LABEL}.txt"

# Prints "<average CPU %> <lowest free RAM MB>" over 6 samples, 5 s apart (30 s).
sample_machine() {
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command '$cpu=@(); $ram=@(); 1..6 | ForEach-Object { $cpu += (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; $ram += [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024); if ($_ -lt 6) { Start-Sleep 5 } }; "{0} {1}" -f [int](($cpu | Measure-Object -Average).Average), ($ram | Measure-Object -Minimum).Minimum' | tr -d '\r'
  else
    local cpu_total=0 ram_min="" n a1 b1 c1 d1 e1 f1 g1 a2 b2 c2 d2 e2 f2 g2 busy idle ram
    for n in 1 2 3 4 5 6; do
      read -r _ a1 b1 c1 d1 e1 f1 g1 _ </proc/stat; sleep 5; read -r _ a2 b2 c2 d2 e2 f2 g2 _ </proc/stat
      busy=$(( (a2-a1)+(b2-b1)+(c2-c1)+(f2-f1)+(g2-g1) )); idle=$(( (d2-d1)+(e2-e1) ))
      [ $((busy+idle)) -gt 0 ] && cpu_total=$(( cpu_total + 100*busy/(busy+idle) ))
      ram=$(( $(awk '/MemAvailable/ {print $2}' /proc/meminfo) / 1024 ))
      if [ -z "$ram_min" ] || [ "$ram" -lt "$ram_min" ]; then ram_min=$ram; fi
    done
    echo "$((cpu_total/6)) $ram_min"
  fi
}

# One line per watched process name: how many are running (they compete for the same CPU and RAM).
process_counts() {
  local name
  for name in $WATCH_PROCESSES; do
    if command -v powershell.exe >/dev/null 2>&1; then
      echo "${name} processes: $(powershell.exe -NoProfile -Command "(Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Measure-Object).Count" | tr -d '\r')"
    else
      echo "${name} processes: $(pgrep -c -x "$name" 2>/dev/null || true)"
    fi
  done
}

echo "== recreate app, wait healthy"
docker compose up -d --no-build --force-recreate app >/dev/null 2>&1
for _ in $(seq 1 60); do curl -sf localhost:3000/api/v1/health >/dev/null && break; sleep 2; done
[ "$(docker compose exec -T app printenv RATE_LIMIT_ENABLED | tr -d '\r')" = "false" ] || { echo "RATE_LIMIT_ENABLED is not false in the app container"; exit 1; }

echo "== analyze + counts"
psql_q "ANALYZE villages; ANALYZE village_names;" >/dev/null
COUNTS="$(psql_q "select (select count(*) from villages)||' villages, '||(select count(*) from village_names)||' village_names, trgm indexes: '||(select count(*) from pg_indexes where indexname like '%trgm%')")"
echo "$COUNTS"

echo "== totals check"
node k6/tools/search-totals.mjs "$TOTALS"

echo "== quiet-machine gate (CPU <= ${MAX_CPU} %, free RAM >= ${MIN_RAM_MB} MB, over 30 s; up to ${MAX_WAIT_MIN} min)"
GATE_OK=0
for attempt in $(seq 1 "$MAX_WAIT_MIN"); do
  read -r CPU_AVG RAM_MIN <<<"$(sample_machine)"
  echo "  check ${attempt}: avg CPU ${CPU_AVG} %, lowest free RAM ${RAM_MIN} MB"
  if [ "$CPU_AVG" -le "$MAX_CPU" ] && [ "$RAM_MIN" -ge "$MIN_RAM_MB" ]; then GATE_OK=1; break; fi
  [ "$attempt" -lt "$MAX_WAIT_MIN" ] && sleep 60
done
if [ "$GATE_OK" -ne 1 ]; then
  echo "GATE FAILED: the machine stayed busy for ${MAX_WAIT_MIN} minutes (last: CPU ${CPU_AVG} %, RAM ${RAM_MIN} MB). Not measuring."
  exit 3
fi
COND="$(printf 'in the 30 s before the warm-up: average CPU %s %%, lowest free RAM %s MB\n' "$CPU_AVG" "$RAM_MIN"; process_counts)"
echo "$COND"

run_k6() { # extra docker arguments follow
  MSYS_NO_PATHCONV=1 docker run --rm --network "$K6_NETWORK" \
    -v "${K6_DIR}:/scripts" \
    -e BASE_URL=http://app:3000 -e VUS=20 "$@" \
    grafana/k6:1.0.0 run /scripts/village-search.js
}

echo "== warm-up (15 s, discarded)"
run_k6 -e DURATION=15s -e LABEL=warmup >/dev/null 2>&1 || true

echo "== measured run (20 VUs, 60 s)"
run_k6 -e DURATION=60s -e "LABEL=${LABEL}" \
  -e "DATASET=${COUNTS}; 20000 perf- seed=1 + 14 real; code=${CODE}" \
  -e "RESULT_FILE=/scripts/results/${DATE}-${LABEL}-20k.json" | tail -40

{
  echo "conditions (same procedure and the same quiet-machine gate for every measurement):"
  echo "$COND" | sed 's/^/  /'
  echo "  procedure: app recreated, ANALYZE, totals check, quiet-machine gate, 15s warm-up (discarded), then 60s measured"
} >> "${OUT}.txt"
echo "== done: ${OUT}.txt"
