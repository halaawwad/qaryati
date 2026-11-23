# Architecture

Qaryati is a **modular monolith**: one Node.js + Express + TypeScript service, split into feature modules that each own their routes, logic and data access ([ADR 0003](adr/0003-modular-monolith.md)).
It runs with PostgreSQL and Redis through Docker Compose. Database tables are described in [erd.md](erd.md).

Items marked *planned* are agreed in the team guide but not merged yet.

## 1. System context

```mermaid
flowchart LR
    client["API clients<br/>(web / mobile, API-Dog)"]
    k6["k6 load tests"]

    subgraph compose["Docker Compose"]
        api["Qaryati API<br/>Node.js 22 · Express 5<br/>:3000"]
        pg[("PostgreSQL 16<br/>:5433 → 5432")]
        redis[("Redis 7<br/>:6380 → 6379")]
    end

    osm["OpenStreetMap<br/>(planned)"]

    client -- "HTTPS / JSON<br/>/api/v1" --> api
    k6 -.-> api
    api -- "Prisma" --> pg
    api -- "rate limits,<br/>cache (planned)" --> redis
    api -. "integrations/geo<br/>(planned)" .-> osm
```

| Service | From your machine | Inside Docker |
|---|---|---|
| API | `localhost:3000` | `app:3000` |
| PostgreSQL | `localhost:5433` | `postgres:5432` |
| Redis | `localhost:6380` | `redis:6379` |

Host ports can be changed in `.env` with `APP_HOST_PORT`, `POSTGRES_HOST_PORT` and `REDIS_HOST_PORT`.

## 2. Modules

Every module lives in `src/modules/<name>` and only reaches another module through that module's service (for example `villageService.ensureExists`), never its repository.

```mermaid
flowchart TB
    app["app.ts · routes.ts<br/>/api/v1"]

    subgraph hala["Platform"]
        auth[auth]
        users[users]
    end
    subgraph yaman["Villages"]
        villages[villages]
        governorates[governorates]
    end
    subgraph sara["Provenance and review"]
        sources[sources]
        audit["audit<br/>recordAudit() used by every write"]
        population["population<br/>(planned)"]
        changes["change-requests<br/>(planned)"]
    end
    subgraph zeina["Village content"]
        events[events]
        landmarks[landmarks]
        heritage[heritage]
        economy[economy]
        facilities[facilities]
    end

    geo["integrations/geo<br/>(planned)"]

    app --> hala & yaman & sara & zeina
    zeina -- "ensureExists" --> villages
    zeina -- "getById" --> sources
    zeina -.-> geo
```

All modules also use `src/shared/`: `db` (Prisma), `cache` (Redis), `logger`, `errors`, `pagination`, and the middlewares `requestId`, `validate`, `authenticate`, `requireRole`, `rateLimit` and `errorHandler`.

| Owner | Modules |
|---|---|
| Hala | `auth`, `users`, `shared/`, project setup, database schema and seed |
| Yaman | `villages`, `governorates`, Redis cache, k6 read tests |
| Sara | `sources`, `audit`, `population`, `change-requests`, k6 write tests |
| Zeina | `events`, `landmarks`, `heritage`, `economy`, `facilities`, `integrations/geo` |

## 3. Layers inside a module

```mermaid
flowchart LR
    routes["*.routes.ts<br/>URL + middlewares"] --> controller["*.controller.ts<br/>HTTP in / out"]
    controller --> service["*.service.ts<br/>business rules"]
    service --> repository["*.repository.ts<br/>Prisma queries"]
    repository --> db[("PostgreSQL")]
    schemas["*.schemas.ts<br/>zod input shapes"] -. "validate()" .-> routes
```

| File | Responsibility |
|---|---|
| `*.routes.ts` | Declares endpoints and their middleware chain |
| `*.controller.ts` | Reads the validated request, calls the service, sends the response. No business logic |
| `*.service.ts` | Rules such as "village must exist", version checks, audit logging |
| `*.repository.ts` | The only layer that talks to the database |
| `*.schemas.ts` | zod schemas for params, query and body |

## 4. Request lifecycle

A write request, for example `POST /api/v1/villages/:villageId/landmarks`:

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant M as Middlewares
    participant R as Route + validate
    participant A as authenticate + requireRole
    participant S as Service
    participant DB as PostgreSQL
    participant E as errorHandler

    C->>M: HTTP request
    Note over M: requestId → pino-http logger → helmet → CORS<br/>→ JSON body (1 MB) → rate limit (Redis)
    M->>R: /api/v1/...
    R->>R: zod validates params / query / body
    R->>A: valid input
    A->>A: verify JWT, check role
    A->>S: controller calls service
    S->>DB: BEGIN
    S->>DB: check parent rows (FOR SHARE)
    S->>DB: insert / update with version check
    S->>DB: recordAudit (same transaction)
    S->>DB: COMMIT
    S-->>C: 201 { "data": ... }
    Note over R,E: Any thrown error goes to errorHandler
    E-->>C: { "error": { code, message, details, requestId } }
```

Read endpoints are public and skip `authenticate`. A transaction makes the change and its audit row succeed or fail together.

## 5. API conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1` |
| List response | `{ "data": [...], "meta": { page, limit, total, totalPages, hasNextPage, hasPrevPage } }` |
| Single item | `{ "data": { ... } }` |
| Errors | `{ "error": { code, message, details: [{ field, message }], requestId } }` |
| Pagination | `page` (default 1), `limit` (default 20, capped at 100) |
| Request ID | `X-Request-Id` header on every response; also in logs and audit rows |
| Health | `GET /api/v1/health` returns `200` or `503` with `db` and `redis` status |
| Roles | Visitor reads; `EDITOR` adds; `REVIEWER` verifies; `ADMIN` deletes and manages users |
| Conflicts | Updates send the `version` they read; a stale version returns `409 CONFLICT` |

## 6. Security

- Passwords hashed with bcrypt (`bcryptjs`); access tokens are short-lived JWTs (HS256); refresh tokens are random, stored only as SHA-256 hashes, and rotated on use ([ADR 0004](adr/0004-authentication-tokens.md)).
- `helmet` security headers, configurable CORS, `x-powered-by` disabled, 1 MB body limit.
- Rate limits stored in Redis: a global API limit plus stricter limits on login, register and refresh. `/health` is not limited.
- Server errors return a generic message; details stay in the logs. The `Authorization` header is redacted from logs.
