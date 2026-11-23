-- Trigram indexes for the village search (GET /api/v1/villages?search=), which Prisma sends as
-- ILIKE '%term%' on villages.name_ar, name_en, slug and village_names.name. A leading wildcard can't use
-- a btree index; a pg_trgm GIN index can serve LIKE/ILIKE with wildcards on both sides.
-- Before/after numbers: k6/results/2026-10-22-*.
--
-- Not CONCURRENTLY: it can't run inside a migration transaction, and the tables are small enough that the
-- brief write lock is acceptable. For a large production table, create these concurrently out of band.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "villages_name_ar_trgm_idx" ON "villages" USING GIN ("name_ar" gin_trgm_ops);

CREATE INDEX "villages_name_en_trgm_idx" ON "villages" USING GIN ("name_en" gin_trgm_ops);

CREATE INDEX "villages_slug_trgm_idx" ON "villages" USING GIN ("slug" gin_trgm_ops);

CREATE INDEX "village_names_name_trgm_idx" ON "village_names" USING GIN ("name" gin_trgm_ops);
