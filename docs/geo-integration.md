# Village geographic review

This feature provides two authenticated ADMIN/REVIEWER operations:

- GET `/api/v1/villages/:id/geo-candidates`
- POST `/api/v1/villages/:id/geo-enrichment`

Public village reads and Nearby Villages remain unchanged. OpenAPI:
[village-geo.yaml](openapi/village-geo.yaml). Design: [ADR-0005](adr/0005-reviewed-village-geo-enrichment.md).

## Configuration

Geo lookup is disabled by default. Set `GEO_ENABLED=true` and a real identifying
`GEO_USER_AGENT`, such as your application name/version followed by your contact URL
or email. Placeholder contacts are rejected when enabled. Do not copy test contacts
into production. `.env.example` lists defaults:

| Variable | Default |
| --- | --- |
| GEO_ENABLED | false |
| GEO_USER_AGENT | Empty; a real identifying contact is required when enabled |
| GEO_NOMINATIM_URL | https://nominatim.openstreetmap.org/search |
| GEO_TIMEOUT_MS | 5000 |
| GEO_CACHE_TTL_SECONDS | 2592000 (30 days) |
| GEO_NEGATIVE_TTL_SECONDS | 300 |
| GEO_CANDIDATE_TTL_SECONDS | 900 |
| GEO_CIRCUIT_THRESHOLD_PERCENT | 50 |
| GEO_CIRCUIT_RESET_MS | 30000 |

The endpoint is operator configuration, never request input. Only public HTTPS DNS
hosts with `/search` and no credentials, custom port, query or fragment are accepted.
Retries are fixed at two maximum; the rate limit cannot be configured above one request
per second. All upstream attempts, including retries, are serialized through Redis.

Read the [public Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
before enabling. It requires an identifying User-Agent, visible attribution and an absolute
application-wide maximum of one request/second. This feature is for moderate, individual,
user-triggered reviews. Do not use it for autocomplete, bulk/backfill jobs or periodic scans.
Display the returned attribution text/link near candidate results and maps; data is ODbL.

## Lookup fallbacks and review flags

Searches run sequentially: Arabic village/governorate/Palestine, English
village/governorate/Palestine (when available), English village name alone, then
Arabic village name alone. Empty and duplicate queries are skipped. Every request
uses `countrycodes=ps`, and returned and cached candidates must have country code
`ps`. Searching stops at the first nonempty set of accepted candidates. Every
fallback and retry acquires the same Redis global permit; the entire lookup shares
a maximum of two transient retries. Timeouts, cooldowns and the circuit breaker
remain active. An interrupted search is never negatively cached.

Only an explicit `governorate` field or a state, state_district or county value
labelled `Governorate`/`محافظة` can establish an exact governorate match. Conflicting
explicit governorates are rejected. General regions, plain administrative names
and missing governorates are `unconfirmed` and require manual review.
For example, Al Walaja can be found by name alone while its regional state
`اليهودا والسامرة` and county `منطقة ج` leave Bethlehem unconfirmed.

Lookup cache identity is now `nominatim:v2`, bypassing earlier positive and negative
entries without deleting Redis data or changing candidate references and coordination
keys. Old entries expire naturally. Candidate expiration, village version checks,
explicit apply/overwrite confirmation and transactional auditing still apply.

## Redis activation and recovery

The official `docker-compose.yml` passes all nine `GEO_*` settings from `.env` or the
shell to the app, using the defaults above and `GEO_ENABLED=false` when unset. Enabling
the environment flag does not set the Redis activation key. The app still uses
`redis://redis:6379` on the Compose network. No automatic activation command is run.

Compose starts Redis with `appendonly yes`, `appendfsync always` and
`maxmemory-policy noeviction`, and mounts the project-scoped named volume `redis_data`
at `/data`. Its Docker name is normally `<compose-project>_redis_data`; keep the same
Compose project name across deployments. PostgreSQL continues using `postgres_data`.
Both database host ports bind to `127.0.0.1` only (defaults 5433 and 6380); containers
continue using service DNS and internal ports. This leaves existing database credentials,
PostgreSQL settings and app host-port behavior unchanged. The Compose network is still
trusted infrastructure; Redis authentication has not been changed or added.

`docker-compose.geo-local.yml` is a local-only override ignored by Git. It is not loaded
by the official file. Use `docker compose -f docker-compose.yml config --quiet` to validate
the official file explicitly if your shell has `COMPOSE_FILE` configured. Any deliberately
selected local overrides can replace settings, so review their effective configuration.

Use the existing REDIS_URL on every replica, with the same Redis database. Use a dedicated
durable primary with `appendonly yes`, `appendfsync always`, `maxmemory-policy noeviction`,
and no automatic failover to stale replicas. Do not use a caching proxy that can lose locks.
Do not change connection/database settings or coordination keys while workers run.

Before first activation, stop all application workers capable of geo lookup. On the
intended Redis primary, using your normal authenticated Redis administration connection:

```text
SET qaryati:geo:{nominatim}:enabled 1
```

Then start workers. Do not expose Redis publicly. No application endpoint activates this
gate. A new empty Redis fails closed. Cached results also require Redis availability.

The active lock deliberately has no expiration. If a process crashes while holding it,
other calls return GEO_BUSY. For a stale lock, failover, state rollback or Redis rebuild:

1. Stop **all** geo-capable application workers; confirm no upstream request remains active.
2. Inspect any existing cooldown TTL; preserve a provider Retry-After pause. If its history
   was lost, do not reactivate until the provider restriction is known to have elapsed.
3. Delete only `qaryati:geo:{nominatim}:lock` on the intended primary. Do not clear cooldown.
4. Set the activation key to `1` only after durable coordination is healthy, then restart.

Never expire/delete an active worker's lock as a shortcut. During ordinary Redis outages,
the code fails closed rather than issue uncoordinated upstream requests. This design
assumes the durable single-primary topology above; asynchronous failover is unsupported.
Geo-specific Redis commands time out after 2 seconds; a late lock acquisition may also
require the stale-lock recovery procedure. Shared Redis behavior for other modules is unchanged.

## Manual transition from an existing anonymous Redis volume

Changing Compose does **not** migrate existing Redis data. Do not recreate Redis with
the new mount before deciding how to preserve its existing state. The following is an
operator-run maintenance procedure, not an automatic deployment hook. No containers or
volumes are changed by `docker compose config --quiet` or by editing the files.

1. Record the existing Compose project name, Redis container ID and its actual `/data`
   volume name using read-only `docker compose ps -q redis` and
   `docker inspect --format '{{json .Mounts}}' <redis-container-id>`. Inspect the intended
   named volume with `docker volume inspect <compose-project>_redis_data` if it exists.
   Never overwrite a pre-existing destination with unknown data. Keep PostgreSQL running
   and leave its container and volume out of this procedure.
2. Schedule downtime. Stop every app/worker and other Redis writer, including processes
   outside Compose, and confirm that no upstream geo request is still in flight. Record
   the activation key, lock, and cooldown TTL with their observation time. Preserve any
   Retry-After restriction; if its history is uncertain, leave geo disabled until resolved.
3. While the old Redis is still running, make a verified snapshot/backup of its current
   dataset using your Redis administration connection (`SAVE`, or completed successful
   `BGSAVE`). Copy the backup outside the volume and keep the original anonymous volume.
   Check persistence status and disk capacity before proceeding. Redis is also used for
   API rate limits and lookup/candidate storage; do not treat all its state as disposable.
4. If the old instance has AOF disabled, enable it on that quiesced instance with
   `CONFIG SET appendfsync always` and `CONFIG SET appendonly yes`. Wait for
   `INFO persistence` to show `aof_enabled:1`, `aof_rewrite_in_progress:0`,
   `aof_rewrite_scheduled:0`, `aof_last_bgrewrite_status:ok` and `aof_last_write_status:ok`.
   Do not simply copy an RDB-only directory and boot with AOF enabled. Redis documents
   the conversion procedure in its [persistence guide](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).
5. Stop the old Redis cleanly. With it stopped, copy its **entire** `/data` directory into
   the verified empty named volume, preserving ownership and permissions. If creating
   the target volume manually, set the Compose labels `com.docker.compose.project` to the
   existing project name and `com.docker.compose.volume` to `redis_data`. Use a temporary
   copy container with the old volume mounted **read-only** and the new volume writable;
   copy `/source/.` into `/destination/`. Redis 7's AOF directory, manifest and all referenced
   files must travel together. Verify the copy against the stopped source/backup. Do not
   rename, delete, prune or reuse the old volume for another purpose.
6. After reviewing the copied data and official Compose configuration, the operator can
   recreate **only Redis** with `docker compose -f docker-compose.yml up -d --no-deps redis`
   under the same project name. Inspect its mount, logs, `INFO persistence`, and
   `CONFIG GET appendonly appendfsync maxmemory-policy`; expect `yes`, `always`, `noeviction`.
   Confirm expected keys and representative values survived, allowing for TTL expiry.
   Keep applications stopped until this validation succeeds. A failed check means stop
   and investigate using the retained backup/source, not clear the new database.
7. Apply the activation/recovery rules above before resuming geo traffic. A preserved
   activation key is not proof that a copied stale lock or cooldown can be discarded.
   Keep `GEO_ENABLED=false` during the transition; enable it and recreate/start the app
   only after coordination is verified and a real User-Agent is configured. Do not launch
   old and new Redis-backed worker groups concurrently. If rollback is needed, quiesce
   all workers again and account for any writes since migration before reverting state.

Do not use `docker compose down -v`, `docker volume prune`, or volume-removal commands
as part of this transition. Retain the old anonymous volume and independent backup until
the operator separately approves their eventual retirement. A fresh empty named volume
is an alternative only after explicitly accepting loss of the old Redis state; it has no
activation key and must stay disabled until provider cooldown history is resolved.

## Manual Postman demonstration

Use a local review database and an existing real village with correct stored governorate.
Do not populate real records with the synthetic coordinates used in automated tests.

1. Configure and activate the integration as above. Start `npm.cmd run dev`.
2. Obtain an ADMIN/REVIEWER access token through the existing login API. In Postman set
   `baseUrl` to the server origin, `villageId` to its UUID and Bearer Token to that token.
3. GET `{{baseUrl}}/api/v1/villages/{{villageId}}/geo-candidates` without a custom search.
   Expect 200 with `data.version`, `data.status`, `data.candidates` and attribution.
4. Inspect the candidate's display name, country/governorate, coordinates, provider
   reference and match flags. Independently verify the location on a map. `ambiguous`
   means choose carefully; `no_match` means do not apply anything. Never choose merely
   because a result is first. Copy the selected `candidateRef` and response `version`.
5. POST `{{baseUrl}}/api/v1/villages/{{villageId}}/geo-enrichment`, JSON body:

   ```json
   { "candidateRef": "<copied UUID>", "version": 1, "confirm": true, "overwriteExisting": false }
   ```

   Use the actual copied version. Expect 200 with persisted coordinates, geoDisplayName,
   geoEnrichedAt, incremented version, unchanged verificationStatus and updatedAt.
6. If coordinates already exist, expect 409. Only after deliberate review, repeat with
   `overwriteExisting: true` and the same still-current candidate/version. A stale version
   needs a new lookup. Both omitted confirmation and arbitrary coordinates are 400.
7. GET the public village details and its `/nearby?radiusKm=5` route to review the result.
   Inspect the Village UPDATE audit for request ID, actor, before/after and provenance.
8. Repeat the successful apply: expect 409. Use an expired/foreign reference: 400.
   Without a token: 401. With EDITOR: 403. Missing/deleted village: 404.

Requests return the existing error envelope `{error:{code,message,details,requestId}}`.
Global body-size/rate-limit middleware still supplies 413/429. Provider failures,
coordination failures, busy/circuit-open/disabled states use controlled 503 errors.
No live Nominatim request is necessary for automated tests.

## Automated verification

```powershell
npx.cmd prisma generate
npm.cmd run typecheck
npm.cmd test -- tests/geo.provider.test.ts tests/villages.geo.service.test.ts tests/villages.geo.routes.test.ts
npm.cmd test
npm.cmd run build
git diff --check
node scripts/test-geo-integration.mjs
```

The last command requires Docker. It creates fresh PostgreSQL 16 and Redis 7 containers
on random loopback ports, overrides connection settings, applies existing migrations only
there, and runs `tests/integration/geo.integration.ts`. HTTP responses are mocked; no real
provider traffic or development/production writes occur. Containers and volumes are removed
in finally. A forcibly killed runner may require removing only its `qaryati-geo-test-*`
containers manually after inspecting their IDs.

No schema/migration change or village cache invalidation was required. All business
verification status is preserved; the audit records manual geo review and OSM provenance.
The current scope is `ps`; OSM coverage/classification and transliteration mismatches can
produce no matches. Broader historical/geographic scope requires an explicit team policy.
