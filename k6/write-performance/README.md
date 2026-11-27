# Isolated Source and Population write performance

This suite targets repository baseline `efa86e0`. It complements the existing
Village workload; it does not test later Sources hardening, Population review or
preferred selection, or Change Request features. Concurrent `http.batch` dispatch does not prove a PostgreSQL lock
wait; that requires a separate instrumented integration test.

## Scope and metrics

Each iteration creates a Source, changes it, submits a stale change, creates a
Population record for a dedicated Village and that Source, changes it, and
submits a stale change. It then creates a second Source and batches two different
PATCH requests using the same version. Exactly one must succeed; a subsequent
GET checks the winning title and incremented version. The synthetic editor owns
all created records. Unique run, phase, VU and iteration identifiers distinguish
fixtures; the distinct Source ID makes the Village/year/source key unique.

k6 records throughput and request count, VUs, iteration starts/completions,
mutation and expected-conflict counters, unexpected statuses and contract failures.
Per-operation latency submetrics include median (p50), p95 and p99. The duration
submetric `max>=0` thresholds only enable reporting and are not latency targets.
The actual correctness gates are zero unexpected responses, zero invalid contracts,
and successful checks. Expected 409s are configured as expected statuses and
counted separately. A failed or incomplete iteration fails reconciliation even if
k6 exits successfully. Warm-up and measured runs are separate k6 invocations and
produce separate events, summaries and audit manifests.

For every attempted write, the workload records a run/phase/VU/iteration/operation
request ID before dispatch and a result after a response. Reconciliation compares
those traces with actual Source and Population audit rows by request ID, entity
identity, action and actor. It rejects missing outcomes, unknown or duplicate audit
rows, mismatches, and started-but-unfinished iterations. A failed response with a
committed mutation also leaves an unexpected audit. A process interrupted before
its trace reaches disk cannot be proven complete; missing outputs fail closed.
The manifests list Source and Population IDs, request counts and expected/actual
audit counts. The setup fixture writes one user, governorate and Village directly
into the fresh test database; it is outside the workload and produces zero audit
rows. Warm-up and measurement are reconciled independently.

## Isolated execution

Use Linux, WSL, or Windows Git Bash with Node.js, Docker Compose v2 and sufficient Docker disk
space. The run may build the application image and download `postgres:16-alpine`,
`redis:7-alpine`, `node:22-bookworm-slim`, and `grafana/k6:1.0.0`; Docker build may
download project dependencies. Obtain permission for those downloads and for
creating/removing the disposable containers before running. Do not use the existing
`measure.sh` or `perf:clean` with this suite.

```bash
# Proposed smoke run: 2 VUs, 5 s warm-up, 10 s measurement
bash k6/write-performance/run.sh smoke

# Proposed comparison run: 20 VUs, 15 s warm-up, 60 s measurement
bash k6/write-performance/run.sh measure

# Optional positive-integer VUs and whole-second durations
VUS=4 WARMUP=5s DURATION=20s bash k6/write-performance/run.sh smoke
```

The runner creates a random project, database/user and credentials; starts a
separate PostgreSQL tmpfs and nonpersistent Redis on a unique Compose network with
no host ports; checks project labels, mounts, network, health, database identity
and zero public objects before starting the app and its migrations. It then checks
the app's database configuration and isolated network before creating fixtures or
dispatching the write workload. A localhost address alone is never accepted as
proof of isolation. k6 accepts only the internal `http://app:3000` target and a
runner gate; do not invoke the workload directly or override the guard. Docker
daemon access and permission to create/remove these resources are required.

The isolated app explicitly disables rate limiting (`RATE_LIMIT_ENABLED=false`);
that setting does not alter the development app. Record this condition when
interpreting results. The runner creates no host-published ports and does not touch
development Compose containers. Its EXIT trap removes only containers and the
network carrying the unique run project label, retaining the output directory
printed at exit. Manually inspect any cleanup failure using those recorded IDs;
never use `docker prune`, `compose down -v`, or the existing Village cleanup script.
The output directory contains synthetic IDs, workload metrics and JSON manifests;
it contains no passwords. Remove that directory manually when no longer needed.
The temporary credentials are generated in process memory and passed as container
environment variables; a user with Docker inspection access can see them while the
containers run. Use no production credentials or data.

Outputs include `environment.json`, `fixtures.json`, per-phase `*-events.json`,
`*-summary.json`, and `*-manifest.json`. An exit other than zero means no passing
result; preserve outputs for diagnosis. `http_req_duration` tags distinguish
operations; use the summary and event stream for per-operation percentiles and
request rates. The guard relies on the runner's Docker identity checks and the
isolated network; direct invocation with forged environment variables bypasses
that runner and is unsupported.

## Limitations

The suite does not establish an authoritative latency or throughput target, reproduce
production hardware, prove database lock waiting, or exercise unmerged features.
The `http.batch` contention pair can be serialized by the server and still
correctly return one stale conflict. Expected performance thresholds and target
load remain team decisions. The fixture database is destroyed after each run;
historical audit remediation and shared-environment testing are outside scope.

## Final smoke verification

On 2026-11-26 the final workload and runner were exercised separately using 2 VUs,
a 5-second warm-up and a 10-second measurement. Warm-up completed 74 iterations
with 444 expected and observed audits; measurement completed 193 iterations with
1,158 expected and observed audits. Neither phase had an interrupted iteration,
unexpected response, failed contract check, or audit discrepancy. The updated
fixture check independently queried the database after setup and found zero audit
rows. Generated summaries excluded setup data and retained summaries were checked
for token and credential patterns. Existing containers remained unchanged.

## Observed isolated run (2026-11-26)

The application baseline was `efa86e0`; it excludes unmerged Sources hardening,
Population review and Change Request features. The workload used for this run
differs from the final workload only in summary output redaction. The final smoke
`workload.js` SHA-256 is
`779556924a35eec9ac3d4b840cb4789f8b19c4686b0b034a1e7e69463cc65396`.
Windows 11 build 26200, Git Bash and Docker Desktop 29.9.3 were used on an
11th Gen Intel Core i7-1165G7, eight logical CPUs and approximately 7.75 GiB RAM;
the k6 image was `grafana/k6:1.0.0`. Rate limiting was disabled in the isolated
application. This single local run is descriptive, not an acceptance target.

| Run and phase | VUs / duration | HTTP requests | requests/s | completed / interrupted | mutations | expected 409s | audit expected / actual |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Smoke warm-up | 2 / 5s | 861 | 148.24 | 86 / 0 | 516 | 258 | 516 / 516 |
| Smoke measurement | 2 / 10s | 1,191 | 111.71 | 119 / 0 | 714 | 357 | 714 / 714 |
| Comparison warm-up | 20 / 15s | 3,001 | 183.83 | 300 / 0 | 1,800 | 900 | 1,800 / 1,800 |
| Comparison measurement | 20 / 60s | 15,951 | 262.20 | 1,595 / 0 | 9,570 | 4,785 | 9,570 / 9,570 |

Rates use k6's elapsed time including graceful completion; each phase includes one
login. Each iteration produced two stale conflicts and one contention loser. The
comparison measurement therefore had 3,190 stale and 1,595 contention conflicts.
No unexpected response or contract failure occurred in any phase. Comparison
measurement checks: 15,950 passed, zero failed.

Comparison-measurement latency in milliseconds (k6 `http_req_duration`):

| Operation | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| Overall | 70.28 | 170.52 | 277.18 |
| Source create | 58.59 | 121.09 | 176.15 |
| Source update | 64.57 | 141.83 | 209.21 |
| Source stale | 48.64 | 103.82 | 157.88 |
| Population create | 121.63 | 260.08 | 391.70 |
| Population update | 105.21 | 226.09 | 327.42 |
| Population stale | 85.69 | 181.39 | 256.44 |
| Contention source create | 57.60 | 122.21 | 173.16 |
| Contention PATCH A | 68.50 | 138.57 | 229.25 |
| Contention PATCH B | 73.75 | 145.76 | 234.58 |
| Contention read | 34.76 | 75.18 | 121.68 |

In the comparison measurement, Source CREATE, Source UPDATE, Population CREATE,
Population UPDATE, contention CREATE and winning contention UPDATE each had
1,595 expected and 1,595 matching audit rows. All 4,785 conflict requests had
zero audit rows. Comparison warm-up had 300 expected and actual rows per category;
the smoke warm-up and measurement had 86 and 119 per category respectively.
The original run expected zero setup audits but did not check after fixture insertion.
Reconciliation checks request ID, actor, entity, action and exact per-request
counts; it does not establish PostgreSQL row-lock waits.

The initial smoke attempt failed before load because mounted scripts could not
resolve Prisma; setting `NODE_PATH` in the isolated app fixed this. The rerun and
comparison both passed. Run the two commands above to reproduce on fresh isolated
resources. Generated summaries now omit k6 setup data, which can contain a token;
avoid committing raw output or exposing temporary container credentials.
