# Qaryati Backend

REST API for Qaryati, built with Node.js 22, Express 5, TypeScript, Prisma (PostgreSQL 16) and Redis 7.

## Prerequisites

- Node.js 22+ and npm
- Docker Desktop (or Docker Engine with the Compose plugin)

## Quick start (Docker)

```bash
cp .env.example .env        # then replace the change_me placeholders
docker compose up --build
```

The API is then available at `http://localhost:3000/api/v1`. Check it with:

```bash
curl http://localhost:3000/api/v1/health
# {"status":"ok","db":"up","redis":"up"}
```

The health endpoint returns `200` when PostgreSQL and Redis are both reachable, and `503` otherwise.

## Ports

docker-compose publishes these host ports. Postgres and Redis use non-default host ports so they don't clash with other local projects. Override any of them in `.env`:

| Service  | Host port (default)          | Container port |
|----------|------------------------------|----------------|
| app      | `APP_HOST_PORT` = 3000       | 3000           |
| postgres | `POSTGRES_HOST_PORT` = 5433  | 5432           |
| redis    | `REDIS_HOST_PORT` = 6380     | 6379           |

Inside the Compose network, containers always talk to each other on the internal ports (`postgres:5432`, `redis:6379`), whatever host ports you choose.

## Local development (app outside Docker)

Run only the database and cache in Docker, and the app on your machine with hot reload:

```bash
docker compose up -d postgres redis
npm install
npm run prisma:generate
npm run dev
```

When you run the app locally, it uses `DATABASE_URL` and `REDIS_URL` from `.env`. These point at the host ports (`localhost:5433` and `localhost:6380`), so if you change `POSTGRES_HOST_PORT` or `REDIS_HOST_PORT`, update the URLs to match.

## Scripts

| Script                    | Description                                   |
|---------------------------|-----------------------------------------------|
| `npm run dev`             | Start the API with hot reload (tsx watch)     |
| `npm run build`           | Compile TypeScript to `dist/`                 |
| `npm start`               | Run the compiled build                        |
| `npm run typecheck`       | Type-check without emitting                   |
| `npm run prisma:generate` | Generate the Prisma client                    |
| `npm run prisma:migrate`  | Create and apply a migration (development)    |
| `npm run prisma:deploy`   | Apply pending migrations (CI / production)    |
| `npm run db:seed`         | Seed the database                             |

## Environment variables

See [`.env.example`](.env.example) for the full list. `.env` is gitignored, so never commit it.

| Variable                                         | Purpose                                                   |
|--------------------------------------------------|-----------------------------------------------------------|
| `NODE_ENV`                                       | `development`, `test` or `production`                     |
| `PORT`                                           | Port the app listens on when run locally                  |
| `LOG_LEVEL`                                      | Pino log level                                            |
| `CORS_ORIGINS`                                   | Comma-separated allowed origins, or `*`                   |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Database credentials, used by docker-compose          |
| `DATABASE_URL` / `REDIS_URL`                     | Connection URLs for local runs (Compose sets its own)     |
| `APP_HOST_PORT` / `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` | Host ports published by docker-compose          |

### Geographic integration

The reviewed village geographic integration is disabled by default.

| Variable | Default | Purpose |
|---|---|---|
| `GEO_ENABLED` | `false` | Enable geographic lookup |
| `GEO_NOMINATIM_URL` | `https://nominatim.openstreetmap.org/search` | Nominatim search endpoint |
| `GEO_USER_AGENT` | Empty | Identifying application name/version and contact |
| `GEO_TIMEOUT_MS` | `5000` | Provider request timeout in milliseconds |
| `GEO_CACHE_TTL_SECONDS` | `2592000` | Successful lookup cache lifetime (30 days) |
| `GEO_NEGATIVE_TTL_SECONDS` | `300` | Negative lookup cache lifetime (5 minutes) |
| `GEO_CANDIDATE_TTL_SECONDS` | `900` | Candidate reference lifetime (15 minutes) |
| `GEO_CIRCUIT_THRESHOLD_PERCENT` | `50` | Circuit breaker failure threshold percentage |
| `GEO_CIRCUIT_RESET_MS` | `30000` | Circuit breaker reset interval in milliseconds |

Enabling geographic lookup requires a valid identifying User-Agent and explicit Redis coordination activation. Follow the [geographic integration guide](docs/geo-integration.md) for configuration, activation, provider usage policy, recovery procedures and testing instructions.

## Population Records, Sources, and Data Integrity

Sources provide attribution for Population records. A Village can have different sourced figures for the same year; the Village/year/Source business key prevents duplicate combinations, including after soft deletion. New records require an active Village and Source. Existing historical Population records retain their source references and remain visible when the Source is soft-deleted.

Source and Population reads are public. EDITOR, REVIEWER and ADMIN can create records; an editor can directly update their own PENDING records, while reviewers and administrators can update PENDING or VERIFIED records. Direct edits to VERIFIED Population and Sources preserve verification status and metadata. Only administrators can soft-delete. Source deletion requires `expectedVersion` and increments it; Population deletion requires no version and does not increment it. Source audit URL snapshots omit query strings and fragments, while the stored URL retains them.

Population anomaly detection compares a new or changed population value with the latest applicable non-deleted VERIFIED record for the Village, excluding the edited record on update. A difference greater than 50% sets `needsReview`; direct edits preserve an existing flag. REVIEWER and ADMIN can verify or reject Population records. VERIFY clears `needsReview`; verifying an already VERIFIED record with the flag set refreshes verification metadata, increments the version and writes an audit. With the flag clear, a matching repeat VERIFY is a no-op. REJECT preserves `needsReview`, clears verification metadata and preference, and selects no replacement.

Reviewers and administrators select a VERIFIED preferred record using its `expectedVersion` and the observed `expectedPreferred` slot ID and version, or `null` for an empty slot. At most one record is preferred per Village and year. Village Population lists return preferred records by default; `includeAll=true` returns all eligible preference values, while explicit `isPreferred=true` or `false` filters by that flag. `includeAll=true` cannot be combined with `isPreferred`; `includeAll=false` permits the explicit filter. The default adds no implicit VERIFIED filter and does not fall back when no preferred record exists. An actual `referenceYear` change clears preference without selecting a replacement; other edits and an unchanged year preserve it. This default changes results for clients that previously expected all records.

An EDITOR can submit an effective Change Request for a VERIFIED Population record using its `baseVersion`. Editors can list and view their own requests; reviewers and administrators can see all and approve or reject pending requests. Approval is a new verification: the Population verifier and Change Request reviewer use the same approver ID and timestamp, and `needsReview` becomes false. Approval applies the proposal, request transition and both audits in one transaction; other pending requests remain pending and can become stale. Self-approval is prohibited, including for administrators; self-rejection is allowed.

The requesting EDITOR can withdraw their own pending request without changing Population, even if the target has become unavailable. As an implementation choice, withdrawal uses the `REJECTED` state, the comment `Withdrawn by requester`, and `withdrawn=true` in the REJECT audit's after snapshot. It is serialized with approval and rejection.

Versioned writes check `expectedVersion` or `baseVersion` and return a conflict for stale values. Authorized matching no-ops do not update or audit; mutations requiring an increment at the signed 32-bit maximum conflict. Guarded writes, uniqueness constraints and locks protect concurrent changes. Business changes and their audits share transactions, so audit failure rolls back the change. Audit records are application-managed, not a database-enforced immutable ledger. See [ADR-0007](docs/adr/0007-conflicting-population-information.md).

### API endpoints

All paths include the `/api/v1` prefix. These 19 operations are described in the [Sources](docs/openapi/sources.yaml), [Population](docs/openapi/population.yaml), and [Change Requests](docs/openapi/change-requests.yaml) OpenAPI documents.

| Module | Method and path | Purpose |
|---|---|---|
| Sources | `GET /api/v1/sources` | List sources |
| Sources | `POST /api/v1/sources` | Create a source |
| Sources | `GET /api/v1/sources/{id}` | Get a source |
| Sources | `PATCH /api/v1/sources/{id}` | Update a source |
| Sources | `DELETE /api/v1/sources/{id}` | Soft-delete a source |
| Population | `GET /api/v1/villages/{villageId}/population-records` | List a Village's records |
| Population | `POST /api/v1/villages/{villageId}/population-records` | Create a record |
| Population | `GET /api/v1/population-records/{id}` | Get a record |
| Population | `PATCH /api/v1/population-records/{id}` | Update a record |
| Population | `DELETE /api/v1/population-records/{id}` | Soft-delete a record |
| Population | `POST /api/v1/population-records/{id}/verify` | Verify a record |
| Population | `POST /api/v1/population-records/{id}/reject` | Reject a record |
| Population | `POST /api/v1/population-records/{id}/preferred` | Select a preferred record |
| Change Requests | `POST /api/v1/change-requests` | Submit a proposal |
| Change Requests | `GET /api/v1/change-requests` | List requests |
| Change Requests | `GET /api/v1/change-requests/{id}` | Get a request |
| Change Requests | `POST /api/v1/change-requests/{id}/approve` | Approve a proposal |
| Change Requests | `POST /api/v1/change-requests/{id}/reject` | Reject a request |
| Change Requests | `POST /api/v1/change-requests/{id}/withdraw` | Withdraw an owned request |

The OpenAPI documents define request bodies, responses and authorization details. An Apidog import should be reviewed against the shared project's existing operations and environments; no import is implied by these files.

### Write performance

The [isolated k6 workload](k6/write-performance/README.md) exercises Source and Population writes at an older baseline, not Change Request approval or withdrawal. A single local 20-VU/60-second comparison reported 15,951 requests, 262.20 requests/s, p50/p95/p99 of 70.28/170.52/277.18 ms, 4,785 expected conflicts and 9,570 expected and actual audit rows, with no unexpected responses or contract failures. Rate limiting was disabled. This closed-loop laptop run is descriptive, not a production-capacity target or proof of a PostgreSQL lock wait.

## Project structure

```
prisma/          Prisma schema, migrations and seed
src/
  config/        Environment validation (zod)
  modules/       Feature modules (villages, heritage, events, ...)
  integrations/  External services
  shared/        DB/Redis clients, logger, errors, middlewares
  app.ts         Express app setup
  routes.ts      API router (/api/v1)
  server.ts      HTTP server and graceful shutdown
docs/            Architecture decision records and images
tests/           Tests
k6/              Load tests
```
