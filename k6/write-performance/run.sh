#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
case "${1:-}" in smoke) vus=${VUS:-2}; warmup=${WARMUP:-5s}; duration=${DURATION:-10s};; measure) vus=${VUS:-20}; warmup=${WARMUP:-15s}; duration=${DURATION:-60s};; *) echo 'Usage: bash k6/write-performance/run.sh smoke|measure' >&2; exit 2;; esac
[[ "$vus" =~ ^[1-9][0-9]*$ && "$warmup" =~ ^[1-9][0-9]*s$ && "$duration" =~ ^[1-9][0-9]*s$ ]] || { echo 'VUS and durations must be positive integers / seconds' >&2; exit 2; }
command -v docker >/dev/null; command -v node >/dev/null
export PERF_RUN_ID="qperf$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('hex'))")"
export PERF_DB="$PERF_RUN_ID" PERF_USER="$PERF_RUN_ID" PERF_EMAIL="$PERF_RUN_ID@integration.invalid"
export PERF_PASSWORD="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")"
export PERF_JWT="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
export PERF_LOGIN_PASSWORD="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")"
output_dir="$(mktemp -d "${TMPDIR:-/tmp}/qaryati-write-perf.XXXXXXXX")"
chmod 777 "$output_dir"
touch "$output_dir/empty.env"
if [[ -n "${MSYSTEM:-}" ]]; then
 export MSYS_NO_PATHCONV=1
 export PERF_OUTPUT_DIR="$(cygpath -w "$output_dir")"
 env_file="$(cygpath -w "$output_dir/empty.env")"
 scripts_dir="$(cygpath -w "$PWD/k6/write-performance")"
else
 export PERF_OUTPUT_DIR="$output_dir"
 env_file="$output_dir/empty.env"
 scripts_dir="$PWD/k6/write-performance"
fi
project="$PERF_RUN_ID"
compose=(docker compose --env-file "$env_file" -p "$project" -f k6/write-performance/compose.yaml)
network="${project}_default"
if docker network inspect "$network" >/dev/null 2>&1 || [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]]; then echo 'Refusing existing project' >&2; exit 1; fi
cleanup() {
 local container label netlabel
 for container in $(docker ps -aq --filter "label=com.docker.compose.project=$project"); do
  label=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>/dev/null || true)
  if [[ "$label" == "$project" ]]; then docker rm -f "$container" >/dev/null || echo "Failed to remove isolated container $container" >&2; fi
 done
 netlabel=$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' "$network" 2>/dev/null || true)
 if [[ "$netlabel" == "$project" ]]; then docker network rm "$network" >/dev/null || echo 'Failed to remove isolated network' >&2; fi
 unset PERF_PASSWORD PERF_JWT PERF_LOGIN_PASSWORD
 echo "Results retained at $output_dir"
}
trap cleanup EXIT
"${compose[@]}" up -d postgres redis
pg=$("${compose[@]}" ps -q postgres); redis=$("${compose[@]}" ps -q redis)
[[ -n "$pg" && -n "$redis" ]] || { echo 'Missing isolated services' >&2; exit 1; }
for id in "$pg" "$redis"; do
 [[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$id")" == "$project" ]] || exit 1
 [[ "$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$id")" == '{}' ]] || { echo 'Unexpected host port mapping' >&2; exit 1; }
done
[[ "$(docker inspect --format '{{json .Mounts}}' "$pg")" == '[]' ]] || { echo 'Persistent database mount detected' >&2; exit 1; }
[[ "$(docker inspect --format '{{json .HostConfig.Tmpfs}}' "$pg")" == *'/var/lib/postgresql/data'* ]] || { echo 'Database tmpfs missing' >&2; exit 1; }
for _ in $(seq 1 60); do [[ "$(docker inspect --format '{{.State.Health.Status}}' "$pg")" == healthy && "$(docker inspect --format '{{.State.Health.Status}}' "$redis")" == healthy ]] && break; sleep 2; done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$pg")" == healthy && "$(docker inspect --format '{{.State.Health.Status}}' "$redis")" == healthy ]] || { echo 'Services not ready' >&2; exit 1; }
identity=$(docker exec "$pg" psql -U "$PERF_USER" -d "$PERF_DB" -Atc "SELECT current_database()||':'||current_user||':'||(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))")
[[ "$identity" == "$PERF_DB:$PERF_USER:0" ]] || { echo 'Fresh database identity check failed' >&2; exit 1; }
"${compose[@]}" up -d --build app
app=$("${compose[@]}" ps -q app)
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$app")" == "$project" ]] || exit 1
[[ "$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$app")" == '{}' ]] || { echo 'Unexpected app host port' >&2; exit 1; }
for _ in $(seq 1 60); do [[ "$(docker inspect --format '{{.State.Health.Status}}' "$app")" == healthy ]] && break; sleep 2; done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$app")" == healthy ]] || { echo 'App not ready' >&2; exit 1; }
# Verify the container's exact DB URL without printing credentials.
expected="postgresql://${PERF_USER}:${PERF_PASSWORD}@postgres:5432/${PERF_DB}?schema=public"
actual=$(docker exec "$app" node -e 'process.stdout.write(process.env.DATABASE_URL)')
[[ "$actual" == "$expected" ]] || { echo 'App DB identity mismatch' >&2; exit 1; }
unset actual expected
# Ensure the app and database are attached to exactly our unique Compose network.
for id in "$app" "$pg" "$redis"; do
 [[ "$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$id")" == "$network" ]] || { echo 'Unexpected service network' >&2; exit 1; }
done
"${compose[@]}" exec -T app node /perf/fixture.cjs
village=$(node -e 'const f=require(process.argv[1]);process.stdout.write(f.villageId)' "$PERF_OUTPUT_DIR/fixtures.json")
printf '{"run":"%s","project":"%s","app":"%s","postgres":"%s","redis":"%s","network":"%s"}\n' "$PERF_RUN_ID" "$project" "$app" "$pg" "$redis" "$network" > "$output_dir/environment.json"
for phase in warmup measure; do
 export PERF_PHASE="$phase"
 span="$duration"; [[ "$phase" == warmup ]] && span="$warmup"
 status=0
 docker run --rm --name "${project}-${phase}" --label "com.docker.compose.project=$project" --network "$network" -v "$scripts_dir:/scripts:ro" -v "$PERF_OUTPUT_DIR:/perf-output" \
  -e PERF_GATE=verified-disposable -e PERF_RUN_ID -e PERF_PHASE -e PERF_EMAIL -e PERF_LOGIN_PASSWORD -e "PERF_VILLAGE_ID=$village" -e "VUS=$vus" -e "DURATION=$span" \
  grafana/k6:1.0.0 run --out "json=/perf-output/${phase}-events.json" /scripts/workload.js || status=$?
 "${compose[@]}" exec -T -e PERF_PHASE="$phase" app node /perf/reconcile.cjs || status=1
 [[ "$status" == 0 ]] || { echo "$phase failed; reconciliation and logs retained" >&2; exit "$status"; }
done
