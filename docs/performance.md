# Village search performance

This page records how the village list search (`GET /api/v1/villages?search=`) was measured under load, what was slow, and what fixed it. It covers the read path only. The write scenario is written but not run yet (see [Write scenario](#write-scenario)).

**Summary:** with 20,014 villages and 26,068 alternate names, the median request went from 908 ms to 176 ms and throughput from 22.7 to 108.7 requests per second, with no errors and identical search results. Trigram indexes alone gave a modest gain; the search query also had to be rewritten as a `UNION` before Postgres would use them for `villages`.

## Setup

| Item | Value |
|---|---|
| Machine | Laptop, AMD Ryzen 5 3500U, 8 logical processors, 6,090 MB RAM, Windows 11 Pro Education |
| Runtime | Docker 29.9.2, Docker Compose stack of `app` (Node 22), `postgres` (16.15, default `shared_buffers` 128 MB) and `redis` |
| Load tool | k6 1.0.0 (`grafana/k6:1.0.0`), run in a container on the Compose network against `http://app:3000` |
| Load | 20 virtual users, constant, 60 s measured after a 15 s warm-up that is discarded |
| Request mix | `search` 35 %, `search_alt_name` 15 %, `search_no_match` 10 %, `governorate` 15 %, `page` 15 %, `governorate_search` 10 % (see [`k6/village-search.js`](../k6/village-search.js)) |
| Data | 20,014 villages (20,000 synthetic `perf-` villages from `npm run perf:data -- --count=20000 --seed=1`, plus the 14 real ones) and 26,068 alternate names. The same seed produces the same rows, so every measurement used identical data |
| Rate limiting | `RATE_LIMIT_ENABLED=false`, set in the local `.env` for the runs only and restored afterwards. Never disabled anywhere else |
| Quiet-machine gate ([`measure.sh`](../k6/tools/measure.sh)) | Before each warm-up the machine is sampled for 30 s. The run only starts if average CPU is below 20 % and free RAM is at least 650 MB; otherwise it waits a minute and checks again, for up to 10 minutes, then gives up without measuring |

The RAM threshold was first 800 MB. With Docker running, this machine settles around 700 MB free (ten checks over ten minutes peaked at 794 MB), so the gate stopped the session twice without measuring. It was lowered to 650 MB, and the actual values of every run are recorded below.

The synthetic data is created by a script that is not part of `prisma/seed.ts` and only ever touches rows whose slug starts with `perf-`. `npm run perf:clean` removes exactly those rows (and, since the write scenario was added, their audit rows).

## Methodology

The procedure is scripted in [`k6/tools/`](../k6/tools/README.md) ([`measure.sh`](../k6/tools/measure.sh), [`search-totals.mjs`](../k6/tools/search-totals.mjs), [`explain.py`](../k6/tools/explain.py)), where the README explains how to run it.

The three measurements were taken **in the same session, one after the other**, with the same procedure each time:

1. Recreate the `app` container and wait until it is healthy. Check that rate limiting is off.
2. `ANALYZE villages, village_names`.
3. Run the totals check (below).
4. Pass the quiet-machine gate.
5. 15 s warm-up (discarded), then 60 s measured.

What changed between the measurements:

| Measurement | App code | Database |
|---|---|---|
| 1. Before | Prisma `OR` query (commit `03c0718`) | No search indexes |
| 2. After the indexes | Same image as 1 | Four `pg_trgm` GIN indexes (`villages.name_ar`, `name_en`, `slug`, `village_names.name`) from the migration |
| 3. After the UNION | `bfebc3a`: `UNION` in a tagged `$queryRaw` | Same indexes, created by the migration when the new app started |

**The totals check.** Before every run, 38 fixed list queries are sent and, for each, `meta.total` and a hash of the ids on pages 1 and 2 are recorded. The queries cover every search term of the load test, governorate and verification filters, three sort orders, and the `%`, `_`, `bei_`, `100%` and `a\b` cases. The files are compared line by line against the first baseline: **all 38 lines are identical in all three measurements**. So the faster queries return exactly the same villages in exactly the same order. The script is [`k6/tools/search-totals.mjs`](../k6/tools/search-totals.mjs); its output is committed with each measurement.

## Results

All four result sets are linked; the numbers below are copied from them.

| | Before | After the indexes | After the UNION |
|---|---|---|---|
| **p50** | 907.9 ms | 699.6 ms | **176.0 ms** |
| **p95** | 1,305.0 ms | 1,013.2 ms | **334.7 ms** |
| **p99** | 1,586.2 ms | 1,133.4 ms | **562.6 ms** |
| **Requests per second** | 22.69 | 29.67 | **108.74** |
| Requests in 60 s | 1,380 | 1,801 | 6,548 |
| **Errors** | 0.00 % | 0.00 % | 0.00 % |
| avg `search` | 1,051.3 ms | 811.8 ms | 222.5 ms |
| avg `search_alt_name` | 1,079.5 ms | 838.1 ms | 224.2 ms |
| avg `search_no_match` | 1,047.0 ms | 792.5 ms | 79.8 ms |
| avg `governorate` | 494.1 ms | 387.2 ms | 89.9 ms |
| avg `page` | 648.1 ms | 528.1 ms | 226.0 ms |
| avg `governorate_search` | 678.9 ms | 419.6 ms | 160.0 ms |
| CPU, 30 s before the warm-up | 10 % | 3 % | 9 % |
| Lowest free RAM, same 30 s | 753 MB | 772 MB | 794 MB |

Files: [before](../k6/results/2026-11-23-before-rerun-20k.txt) ([json](../k6/results/2026-11-23-before-rerun-20k.json), [totals](../k6/results/2026-11-23-totals-before-rerun.txt)), [after the indexes](../k6/results/2026-11-23-after-indexes-20k.txt) ([json](../k6/results/2026-11-23-after-indexes-20k.json), [totals](../k6/results/2026-11-23-totals-after-indexes.txt), [EXPLAIN](../k6/results/2026-11-23-explain-after-indexes.txt)), [after the UNION](../k6/results/2026-11-23-after-union-20k.txt) ([json](../k6/results/2026-11-23-after-union-20k.json), [totals](../k6/results/2026-11-23-totals-after-union.txt), [EXPLAIN](../k6/results/2026-11-23-explain-after-union.txt)).

**Original baseline, for reference.** The first "before" run ([result](../k6/results/2026-11-23-before-20k.txt), [totals](../k6/results/2026-11-23-totals-before.txt), [EXPLAIN](../k6/results/2026-11-23-explain-before.txt), commit `36c0895`) was taken earlier the same day: 1,261 requests, 20.68 req/s, p50 975.2 ms, p95 1,505.2 ms, p99 1,782.4 ms, no errors, with CPU 7 % and 909 MB free (a single sample at the start of the run, with a few background desktop processes with no open windows still running). It is the baseline the totals files are compared against. The re-run above replaces it in the table because it was taken under the same gate as the other two.

Older files in `k6/results/` dated 2026-10-22 come from an earlier session on older code and are not comparable with these.

## Analysis

**Before: sequential scans.** Every search runs two statements (a count and a page). Both scan all of `villages`, and the `village_names` subquery scans that table too. [The EXPLAIN](../k6/results/2026-11-23-explain-before.txt) shows 188 to 211 ms per statement.

**Indexes alone were not enough.** After the four indexes were built, `villages` was still scanned sequentially for every search term ([EXPLAIN](../k6/results/2026-11-23-explain-after-indexes.txt), 156 to 175 ms per statement). Only the small subquery on `village_names` started using its index, which is where the 23 % lower median comes from.

The cause is the query Prisma writes for `contains` with `mode: 'insensitive'` over several fields and a relation:

```sql
name_ar ILIKE $1 OR name_en ILIKE $1 OR slug ILIKE $1
OR id IN (SELECT village_id FROM village_names WHERE ... name ILIKE $1)
```

The `IN (subquery)` branch cannot use an index, and one branch of an `OR` that cannot use an index stops Postgres from combining the others, so it falls back to scanning every row. It is not `lower()` or the insensitive mode: `ILIKE` matches `gin_trgm_ops` fine. Three hand-written queries for the term `الزيتون` (at the end of the EXPLAIN file; the same queries are in [`k6/tools/explain-or-vs-union.sql`](../k6/tools/explain-or-vs-union.sql)) show it:

| Query | Plan | Time |
|---|---|---|
| A. Only the three `villages` conditions, no subquery branch | `BitmapOr` over the three trigram indexes | 7.5 ms |
| B. `UNION` of the `villages` match and the `village_names` match | `BitmapOr` + Bitmap Index Scan on `village_names` | 26.1 ms |
| C. As Prisma writes it (the `OR` with the `IN` subquery) | Sequential scan of `villages` | 91.0 ms |

**After: the UNION.** The search now collects matching ids with a `UNION` (villages by name or slug, villages through `village_names`), pages them, and loads the rows with the same `select` as before. Each side of the `UNION` can use its own indexes. [The EXPLAIN](../k6/results/2026-11-23-explain-after-union.txt) shows a `BitmapOr` over `villages_name_ar_trgm_idx`, `villages_name_en_trgm_idx` and `villages_slug_trgm_idx`, plus a Bitmap Index Scan on `village_names_name_trgm_idx`, for all four terms tried. Statement times are 11.6 to 32.2 ms for terms with matches and about 1.6 ms for a term with none (down from 188 to 211 ms).

The page query still reads all of `villages` for the final join with the ids (about 3 ms), which is cheap at this size.

## Caveats

- **One run per measurement.** Each number comes from a single 60 s run. Run-to-run noise on this machine is not measured separately; the two "before" runs (908 ms and 975 ms median, taken about two hours apart under slightly different conditions) differ by 7 %, so ±10 % is a reasonable allowance. The five-fold differences are far outside that; the difference between "before" and "after the indexes" (about 23 % on the median) is closer to it and should be read as "modest", not as a precise figure.
- **Conditions are close, not identical.** CPU was 10 %, 3 % and 9 %, and the lowest free RAM 753, 772 and 794 MB, all above the 650 MB gate but below the 909 MB of the original baseline. Background processes: Chrome was closed, and a few background desktop processes with no open windows were stopped before the final session. A few such processes stayed (one of them could not be stopped without elevated rights); they were the same for the three runs.
- **The gain on `governorate` and `page` is indirect.** Those requests have no search term, and their code and queries did not change. They got faster (for example `governorate` 494 ms to 90 ms) because the load test is closed-loop with a fixed 20 users: while sequential scans were consuming the CPU, every other query waited too. Likewise, the 4.8 times higher request rate is mostly a consequence of each user finishing requests sooner. Neither is an independent improvement of those endpoints.
- **Small dataset, laptop hardware.** 20,000 villages is a realistic order of magnitude for this data, but absolute numbers will differ on other hardware. The indexes are not created `CONCURRENTLY` (that cannot run inside a migration transaction); for a much larger production table they should be created out of band, as the migration comment says.
- **The warm-up is short** (15 s), so caches are mostly but not fully warm; it was the same for all three runs.

## Search term escaping (fixed)

The search term used to be passed to `ILIKE` as `%term%` without escaping, so `%` and `_` acted as wildcards: `search=%` returned every village (20,014 in the test data), `bei_` matched the same villages as `beit`, and a backslash was the `LIKE` escape character. The measurements above were taken with that behaviour on purpose, so that the totals stayed identical (the totals check includes these cases).

It is fixed on `fix/village-search-escape-wildcards`: the term is escaped (`\`, `%` and `_` each get a backslash in front) before it goes into `%term%`, so all three are matched literally. `search=%` now finds the names that contain a percent sign, `bei_` no longer matches `beit`, and `100%` and `a\b` match as written. Ordinary Arabic, English, alternate-name and slug searches behave as before. This is covered by unit tests and by a PostgreSQL integration test (`tests/integration/villages.search.postgres.integration.ts`, run with `npm run test:integration`). The five wildcard queries in the totals check are expected to change with this fix and nothing else is.

The k6 numbers in this page were measured before the fix and were not repeated after it. The fix does not change the plan (see below), but it has not been measured under load.

### Why there is no `ESCAPE` clause

The obvious way to write the fix is `ILIKE ... ESCAPE '\'`. It is not used, because it changes the plan. A backslash is already PostgreSQL's default `LIKE` escape character, so the clause adds nothing to the result, but with it the planner stops using the trigram indexes on `villages` and goes back to a sequential scan. Measured with `EXPLAIN ANALYZE` on the 20,014 villages, on the `UNION` count query, with a literal pattern and with a bound parameter (a prepared statement forced to a generic plan, the hardest case; this is how the application sends it):

| Term | With `ESCAPE '\'` | Without it (default escape) |
|---|---|---|
| `bei_`, literal pattern (no matches) | 191.8 ms, sequential scan on `villages` | 12.9 ms, `BitmapOr` over the three indexes |
| `الزيتون`, literal pattern (about 1,000 matches) | 245.2 ms, sequential scan | 111.9 ms, `BitmapOr` |
| `bei_`, bound parameter | 259.7 ms, sequential scan | 7.9 ms, `BitmapOr` |
| `الزيتون`, bound parameter | 270.3 ms, sequential scan | 129.4 ms, `BitmapOr` |

The clause costs 190 to 270 ms in every case; without it a selective term takes 8 to 13 ms and a common one 110 to 130 ms. With the clause the estimated cost of an index scan is much higher (about 320, against 21 to 53 without it) and the planner chooses the sequential scan; that is what the plans show, not an analysis of the planner's internals. The results are the same either way (`bei_` finds 0 villages, `beit` finds 1,993). The plans and timings are in [the EXPLAIN file](../k6/results/2026-11-23-explain-escape-clause.txt). The comment on `escapeLikePattern` says not to add the clause back without measuring again.

## Write scenario

[`k6/village-writes.js`](../k6/village-writes.js) was run against the village write endpoints on `main` (#31, #38 and #39), with the `UNION` search and the trigram indexes in place. It is a different kind of load from the search test: every request writes, in one transaction, the change and its audit row.

**What it does.** Each iteration walks one `perf-w-` village through create, update, update, a stale update, verify, update, reject and delete (eight requests, seven of them writes), so no two virtual users ever touch the same row. The stale update sends an old `version` on purpose: its 409 is the correct answer, so it is counted separately (`expected_version_conflicts`) and is not an error, while a 409 anywhere else, or any other unexpected status, counts as one. The scenario logs in once as the seeded admin and uses that token for every request; an admin may call all five endpoints.

**Setup.** The same as for the search measurements: 20 virtual users, 60 s measured after a 15 s warm-up that is discarded, the same 20,014 villages and 26,068 alternate names, the same machine and Docker stack, `RATE_LIMIT_ENABLED=false` locally for the run only, and the same quiet-machine gate (CPU 9 %, lowest free RAM 676 MB in the 30 s before the warm-up; Chrome and Edge not running). The image was built from the merge of `main` (`dec2f22`) into the performance branch.

### Results

20 virtual users for 60 s: 1,023 complete iterations, 8,185 requests (the 8,184 of the iterations and the login in setup), **133.52 requests per second**, **0 errors**.

| | p50 | p95 | p99 | Average | Requests | Per second |
|---|---|---|---|---|---|---|
| **All requests** | **141.9 ms** | **215.6 ms** | **289.5 ms** | 146.9 ms | 8,185 | 133.52 |
| `create` | 146.0 ms | 204.0 ms | 323.4 ms | 156.3 ms | 1,023 | 16.7 |
| `update` | 152.4 ms | 229.9 ms | 313.2 ms | 161.6 ms | 3,069 | 50.1 |
| `stale_update` (409 expected) | 88.4 ms | 138.6 ms | 190.2 ms | 94.2 ms | 1,023 | 16.7 |
| `verify` | 152.1 ms | 231.5 ms | 302.4 ms | 159.2 ms | 1,023 | 16.7 |
| `reject` | 149.0 ms | 220.7 ms | 270.4 ms | 156.9 ms | 1,023 | 16.7 |
| `delete` (soft delete) | 120.4 ms | 168.2 ms | 200.6 ms | 123.2 ms | 1,023 | 16.7 |

The slowest single request was a `create` at 1,103 ms; every other request finished within 720 ms.

**Version conflicts.** 1,023 expected 409s (one stale update per iteration, counted on their own) and **0 unexpected 409s**. No other status outside the expected ones either.

**Audit.** `audit_logs` grew from 1,540 to 8,701 rows during the measured run: **+7,161, exactly the 7,161 successful writes counted by k6** (7 per iteration). The stale updates, which are refused before anything is written, added no row. After the run, every complete flow had left its rows: the numbers of `CREATE`, `VERIFY`, `REJECT` and `DELETE` rows for these villages were equal, and there were three times as many `UPDATE` rows. [Result](../k6/results/2026-11-23-writes-20k.txt) and [raw k6 output](../k6/results/2026-11-23-writes-20k.json).

### Caveats

- **One run of 60 s.** The same allowance as for the search measurements applies (about ±10 %); do not read differences of a few milliseconds between the request kinds as real.
- **No contention is measured.** Every iteration works on its own village, so the numbers show the cost of a write on its own, not what happens when several people edit the same row. The only conflicts are the deliberate stale updates.
- **The cost of the indexes on writes is not separated.** The four trigram GIN indexes are maintained when a village or a name is written. Nothing was measured without them, so this page cannot say how much of the roughly 150 ms per write they account for.
- **One token, one role.** All requests use the admin's token. The role check is the same cost for every role, but the scenario says nothing about the other roles, and the permission rules for editors (own `PENDING` villages only) are covered by tests, not by this load.
- **The table grows during the run.** The warm-up and the measured run together created 1,243 villages (all soft-deleted by the scenario), on top of the 20,014, and the audit table grew by the same amount of rows; at this size that should not matter, but the data is not exactly the same at the start and at the end.
- **Closed-loop, small hardware.** Twenty virtual users each wait for their answer before the next request, so the request rate follows from the latencies, on a laptop with the database, the application and the load generator on the same machine. Absolute numbers will differ elsewhere.

`npm run perf:clean` removes the `perf-` and `perf-w-` villages, their alternate names and their audit rows afterwards. `SCENARIO=writes k6/tools/measure.sh` reruns the measurement with the same procedure (see the [tools README](../k6/tools/README.md)).
