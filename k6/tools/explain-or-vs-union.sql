-- Why the village search could not use the trigram indexes with Prisma's OR query, and why a UNION can.
-- Read-only. Run it with a search term (default الزيتون):
--   docker compose exec -T postgres psql -U <user> -d <db> -v term=الزيتون -f - < k6/tools/explain-or-vs-union.sql
-- Needs the four pg_trgm indexes (the 20261022140729_add_trigram_search_indexes migration).
--
--   A: only the three villages conditions (name_ar, name_en, slug)   -> BitmapOr over the three indexes
--   B: UNION of the villages match and the village_names match       -> both sides use their indexes
--   C: what Prisma generates: the same OR plus an IN-subquery branch -> sequential scan of villages
-- The IN-subquery branch inside the OR cannot use an index, so Postgres cannot combine the other branches.
\set term_default 'الزيتون'
\if :{?term}
\else
  \set term :term_default
\endif
\pset pager off

\echo '--- A: villages only, no subquery branch'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM villages
WHERE deleted_at IS NULL AND (name_ar ILIKE '%' || :'term' || '%' OR name_en ILIKE '%' || :'term' || '%' OR slug ILIKE '%' || :'term' || '%');

\echo '--- B: UNION form (ids from villages UNION ids from village_names)'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM (
  SELECT id FROM villages
  WHERE deleted_at IS NULL AND (name_ar ILIKE '%' || :'term' || '%' OR name_en ILIKE '%' || :'term' || '%' OR slug ILIKE '%' || :'term' || '%')
  UNION
  SELECT v.id FROM village_names n JOIN villages v ON v.id = n.village_id
  WHERE v.deleted_at IS NULL AND n.deleted_at IS NULL AND n.name ILIKE '%' || :'term' || '%'
) ids;

\echo '--- C: as Prisma writes it (OR with an IN-subquery branch)'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM villages
WHERE deleted_at IS NULL AND (name_ar ILIKE '%' || :'term' || '%' OR name_en ILIKE '%' || :'term' || '%' OR slug ILIKE '%' || :'term' || '%'
  OR id IN (SELECT village_id FROM village_names WHERE deleted_at IS NULL AND village_id IS NOT NULL AND name ILIKE '%' || :'term' || '%'));
