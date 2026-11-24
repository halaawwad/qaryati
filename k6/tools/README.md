# k6 measurement tools

Helpers for measuring the village list endpoint (`GET /api/v1/villages`) with [`k6/village-search.js`](../village-search.js) in a repeatable way. The numbers and the method are written up in [`docs/performance.md`](../../docs/performance.md).

| File | What it does |
|---|---|
| [`measure.sh`](measure.sh) | One measurement, always the same procedure: recreate the app container, `ANALYZE`, run the totals check, wait for a quiet machine, 15 s warm-up (discarded), then 60 s with 20 virtual users. Writes `k6/results/<date>-<label>-20k.{json,txt}` and the totals file. |
| [`search-totals.mjs`](search-totals.mjs) | Sends 38 fixed list queries and records `meta.total` plus a hash of the ids on pages 1 and 2. Diff two outputs: identical means the search returns exactly the same villages in the same order. Includes the `%` and `_` cases. |
| [`explain.py`](explain.py) | Captures the SQL the API really runs for four search terms (from the Postgres statement log) and saves `EXPLAIN (ANALYZE, BUFFERS)` for each statement. |
| [`explain-or-vs-union.sql`](explain-or-vs-union.sql) | Three hand-written queries (A, B, C) that show why Prisma's `OR` with an `IN` subquery cannot use the trigram indexes and a `UNION` can. Read-only. |

## Before you start

- A local Compose stack that is up (`docker compose up -d`), with the app image built from the code you want to measure. `measure.sh` does **not** build: building is heavy, so do it before a run, not during one.
- `RATE_LIMIT_ENABLED=false` in your **local** `.env` for the duration of the runs, otherwise the limiter answers with 429s. Remove it afterwards.
- The synthetic data: `npm run perf:data -- --count=20000 --seed=1` (the same seed always gives the same rows, so runs are comparable). It only writes villages whose slug starts with `perf-`, and refuses to run against a non-local database.
- Docker and Node. The k6 container (`grafana/k6:1.0.0`) is pulled on first use.
- A Windows (PowerShell) or Linux host, for the quiet-machine gate. The Windows path is the one that has been used; the Linux sampling (`/proc`) is untested.

## A typical session

```bash
# 1. Measure the current state (label and description end up in the file names and the result header).
k6/tools/measure.sh before 2026-11-23 "main@abc1234, no search indexes"
python k6/tools/explain.py k6/results/2026-11-23-explain-before.txt \
  "BEFORE trigram indexes" "Date: 2026-11-23   Code: main@abc1234   Data: 20014 villages, 26068 village_names"

# 2. Change something (add the indexes, change the query), rebuild the image, measure again.
k6/tools/measure.sh after-indexes 2026-11-23 "main@abc1234 + trigram indexes"

# 3. The results must not have changed: every line identical.
diff k6/results/2026-11-23-totals-before.txt k6/results/2026-11-23-totals-after-indexes.txt

# 4. Why a query is (not) using an index. Pass a term with -v, or leave it out for the default.
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v term=Deir -f - < k6/tools/explain-or-vs-union.sql

# 5. Clean up: remove the synthetic data, and remove RATE_LIMIT_ENABLED=false from .env.
npm run perf:clean
```

To compare several variants fairly, take all the measurements **in one session**, one after the other, and keep the machine otherwise idle.

## The write scenario

`SCENARIO=writes` makes `measure.sh` run [`k6/village-writes.js`](../village-writes.js) instead of the search scenario, with the same procedure and the same gate (no totals check):

```bash
SCENARIO=writes k6/tools/measure.sh writes 2026-11-23 "main@abc1234, UNION search and the trigram indexes"
```

It needs the village write endpoints, and logs in as the seeded admin from `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` in `.env` (or `ADMIN_EMAIL` and `ADMIN_PASSWORD`); the values are passed to the k6 container by name, so they never appear on a command line. The result file adds a reconciliation line: the growth of `audit_logs` during the measured run against the number of successful writes counted by k6 (they must match, because every successful write adds one audit row and the deliberate stale update, a 409, adds none). The villages it creates have slugs starting with `perf-w-`, and `npm run perf:clean` removes them and their audit rows.

## The quiet-machine gate

Before the warm-up, `measure.sh` samples the machine for 30 s. If the average CPU is above `MAX_CPU` (default 20 %) or the lowest free RAM is below `MIN_RAM_MB` (default 650 MB) it waits a minute and checks again, up to `MAX_WAIT_MIN` (default 10) minutes. If the machine is still busy it exits with code 3 and measures nothing. The CPU and RAM values and the number of processes named in `WATCH_PROCESSES` (default `chrome msedge`) are appended to the result file, so a result always says under which conditions it was taken. All three settings can be overridden through the environment, for example `MIN_RAM_MB=800 k6/tools/measure.sh ...`.

## Other settings

| Variable | Used by | Default |
|---|---|---|
| `K6_NETWORK` | `measure.sh` | `<project folder>_default`, the Compose network |
| `POSTGRES_USER`, `POSTGRES_DB` | `measure.sh`, `explain.py` | read from `.env`, else `qaryati` |
| `BASE` | `search-totals.mjs` | `http://localhost:3000/api/v1` |
| `BASE_URL` | `explain.py` | `http://localhost:3000` |

## Notes

- `explain.py` changes a Postgres setting (`log_statement`) for a few seconds and resets it afterwards. Use it only against the local database.
- The write scenario, [`k6/village-writes.js`](../village-writes.js), is not run by these tools yet; see the last section of `docs/performance.md`.
