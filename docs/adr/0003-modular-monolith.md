# ADR-0003: Modular monolith with a fixed layered module structure

## Status
Accepted (team decision, October 2026)

## Context
Qaryati is one domain (Palestinian villages) with closely related data:
villages, population, sources, heritage, landmarks, audit logs and change
requests. Most writes touch several of these in one transaction, for example
a change plus its audit row.

Four developers work in parallel and must be able to build their features
independently, without stepping on each other's code. The course grades
architecture, clear boundaries, testability and controlled coupling.

## Decision
- **One deployable application (modular monolith),** one PostgreSQL database,
  one Redis instance.
- **One folder per feature** under `src/modules/` (auth, users, villages,
  governorates, sources, population, audit, change-requests, events,
  landmarks, heritage, economy, facilities). Each developer owns their modules.
- **The same layers inside every module:**
  - `*.routes.ts`: URLs, authentication, role checks and validation middleware.
  - `*.controller.ts`: reads the request and writes the response; no business logic.
  - `*.service.ts`: all business rules (permissions on data, conflicts,
    versioning, audit decisions).
  - `*.repository.ts`: the only layer that talks to Prisma or native SQL.
  - `*.schemas.ts`: Zod schemas for input and the derived types.
- **Dependency direction:** routes → controller → service → repository.
  Services never import Express; repositories never contain business rules.
- **Shared code** lives in `src/shared/` (database and Redis clients, logger,
  error types, pagination, middlewares such as `authenticate`, `requireRole`,
  `validate`, `rateLimit`). Changes to it go through a reviewed PR.
- **Cross-module use** goes through a module's exported service functions
  (for example `recordAudit` from the audit module), never through another
  module's repository or tables directly.
- **External providers** sit behind an interface in `src/integrations/`
  (for example a geocoding provider), so a provider can be replaced without
  touching the modules that use it.
- **All routes** are mounted under `/api/v1` from one central router.

## Alternatives considered
- **Microservices:** independent deployment and scaling, but they would split
  data that must change in one transaction (a change and its audit row),
  require distributed transactions or eventual consistency, and add
  networking, service discovery and operational work far beyond the needs and
  the deadline of this project.
- **A single layered application without modules** (global controllers/,
  services/, repositories/ folders): simple at first, but features get mixed,
  ownership is unclear, and four people editing the same folders causes
  constant merge conflicts.
- **Full hexagonal architecture in every module:** cleaner isolation, but more
  interfaces and boilerplate than this domain needs. We apply the idea only
  where it pays off: around external providers.

## Consequences
- Each developer works in their own module folders, so parallel work and
  reviews stay small and focused.
- Business rules sit in services and can be unit tested with a mocked
  repository, without a database or HTTP server.
- Multi-table writes stay simple and consistent with database transactions.
- The whole application scales as one unit. If one area ever needs to scale
  separately, the module boundaries make it possible to extract it later.
- The boundaries are enforced by convention and review, not by the compiler,
  so every PR is expected to keep the layer and dependency rules.
