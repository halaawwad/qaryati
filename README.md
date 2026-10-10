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
