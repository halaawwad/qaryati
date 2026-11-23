# ADR-0002: Technology stack: Node.js, Express 5, TypeScript, PostgreSQL, Prisma, Redis

## Status
Accepted (team decision, October 2026)

## Context
The course allows Spring Boot, Node.js (Express or NestJS), or Django REST /
FastAPI. A relational database and an ORM are mandatory, and selected data
access must also use native SQL. The system must run consistently in Docker.

Four developers build separate modules in parallel against a shared codebase,
under a fixed deadline. The team's strongest shared experience is
JavaScript/Node.js and Express.

## Decision
- **Runtime and framework:** Node.js 22 with Express 5. Express 5 forwards
  rejected promises from async handlers to the error middleware, so every
  module can rely on one unified error handler.
- **Language:** TypeScript in strict mode (pinned to 5.x). Shared types across
  modules catch contract mistakes between team members at compile time.
- **Database:** PostgreSQL 16. It supports partial unique indexes, CHECK
  constraints, window functions and `pg_trgm`, which our data rules, analytics
  queries and search optimisation rely on.
- **ORM:** Prisma 6 (pinned). Typed client, versioned migrations, and
  `$queryRaw` tagged templates for parameterised native SQL where the ORM is a
  poor fit (distance search, window functions, constraints in migrations).
- **Validation:** Zod schemas validate every request and provide the
  TypeScript types for the same data.
- **Cache and rate-limit store:** Redis 7 through ioredis.
- **Supporting libraries:** pino / pino-http for structured logs with request
  IDs, helmet and cors for HTTP hardening, jsonwebtoken and bcryptjs for
  authentication, vitest and supertest for tests.
- **Packaging:** a multi-stage Dockerfile running as a non-root user, and
  Docker Compose for app + PostgreSQL + Redis with health checks. Migrations
  are applied before the app starts; if they fail, the app does not start.

## Alternatives considered
- **Spring Boot:** mature and well structured, but slower to deliver for a
  team whose experience is mainly in JavaScript.
- **NestJS:** gives structure out of the box, but adds decorators, dependency
  injection and module conventions the team would have to learn first.
  We get comparable structure with plain Express and a fixed module layout
  (see ADR-0003).
- **Django REST / FastAPI:** strong options, but would split the team's
  language experience.
- **TypeORM / Sequelize instead of Prisma:** weaker type safety and a less
  predictable migration workflow.
- **MySQL instead of PostgreSQL:** lacks partial unique indexes, which we use
  to allow only one preferred population record per village and year.

## Consequences
- One language end to end; shared middlewares and types are reused by every
  module.
- Prisma is pinned to 6.x on purpose. Prisma 7 changes configuration and the
  client setup; upgrading is a separate, planned change. This also means some
  Prisma CLI audit findings are accepted for now (see `docs/security.md`).
- TypeScript is pinned to 5.x for tooling compatibility.
- Express gives no structure by itself, so the module layout and layering rules
  in ADR-0003 are mandatory for every developer.
- Native SQL is limited to cases where it is clearly better, and always uses
  parameterised tagged templates (never string concatenation).
