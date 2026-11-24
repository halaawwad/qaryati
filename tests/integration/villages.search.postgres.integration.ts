// Village search against a real PostgreSQL: % _ and \ in the search term are matched literally.
// The mocked unit tests can only show the SQL; this shows what the database does with it.
//
// Same rules as sources.postgres.integration.ts: opt-in, and only the isolated local database
//   QARYATI_POSTGRES_INTEGRATION=1 DATABASE_URL=postgresql://qaryati_local:<password>@127.0.0.1:55433/qaryati_local?schema=public
//   npm run test:integration
// The database needs the migrations applied (npx prisma migrate deploy). One way to get it:
//   docker run -d --name qaryati-integration-pg -p 127.0.0.1:55433:5432 -e POSTGRES_USER=qaryati_local \
//     -e POSTGRES_PASSWORD=<password> -e POSTGRES_DB=qaryati_local postgres:16-alpine
//
// It creates its own governorate and five villages (and one alternate name) and removes exactly those rows by id.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { villageRepository as Repository } from '../../src/modules/villages/villages.repository.js';

let db: PrismaClient;
let repository: typeof Repository;
let verified = false;
const runId = randomUUID().slice(0, 8);
const governorateId = randomUUID();
const villageIds = new Map<string, string>();
const nameIds: string[] = [];

function validateTarget(): void {
  if (process.env.QARYATI_POSTGRES_INTEGRATION !== '1') throw new Error('PostgreSQL integration opt-in required');
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
        url.port !== '55433' || url.pathname !== '/qaryati_local' || url.hash ||
        [...url.searchParams.keys()].some(key => key !== 'schema') ||
        (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')) throw new Error();
  } catch {
    throw new Error('Integration database target is not allowed');
  }
}

// Re-throw without the original stack or Prisma metadata, which can contain connection details.
function safeFailure(error: unknown): never {
  const code = typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : 'UNKNOWN';
  throw new Error(`Integration operation failed (code: ${code}); inspect the failing test name`);
}

function safeTest(fn: () => Promise<void>): () => Promise<void> {
  return async () => { try { await fn(); } catch (error) {
    // Keep assertion failures readable: they carry no connection details.
    if (error instanceof Error && error.name === 'AssertionError') throw error;
    safeFailure(error);
  } };
}

// Each special character appears in exactly one fixture, and every name carries the run id, so rows left by
// anything else cannot be mistaken for these.
const slug = (key: string): string => `integration-search-${runId}-${key}`;

beforeAll(async () => {
  validateTarget();
  // Dynamic imports ensure no Prisma client is initialized before validation.
  try {
    const { PrismaClient } = await import('@prisma/client');
    db = new PrismaClient({ log: [] });
    vi.doMock('../../src/shared/db.js', () => ({ prisma: db }));
    const identity = await db.$queryRaw<Array<{ database: string; username: string }>>`SELECT current_database() AS database, current_user AS username`;
    if (identity.length !== 1 || identity[0]?.database !== 'qaryati_local' || identity[0]?.username !== 'qaryati_local') {
      throw new Error('Integration database identity is not allowed');
    }
    verified = true;
    repository = (await import('../../src/modules/villages/villages.repository.js')).villageRepository;

    await db.governorate.create({ data: { id: governorateId, nameAr: `محافظة ${runId}`, nameEn: `Integration ${runId}`, code: `I${runId}` } });
    const fixtures: [string, string, string][] = [
      ['underscore', `بيت ألفا ${runId}`, `Bei_ Alpha ${runId}`],
      ['beit', `بيت بيتا ${runId}`, `Beit Beta ${runId}`],
      ['percent', `قرية جاما ${runId}`, `100% Gamma ${runId}`],
      ['backslash', `قرية دلتا ${runId}`, `A\\B Delta ${runId}`],
      ['plain', `قرية عادية ${runId}`, `Plain Epsilon ${runId}`],
    ];
    for (const [key, nameAr, nameEn] of fixtures) {
      const id = randomUUID();
      villageIds.set(key, id);
      await db.village.create({ data: { id, slug: slug(key), nameAr, nameEn, governorateId } });
    }
    const nameId = randomUUID();
    nameIds.push(nameId);
    await db.villageName.create({
      data: { id: nameId, villageId: villageIds.get('plain') as string, name: `Dayr Epsilon ${runId}`, language: 'en', nameType: 'ALT_SPELLING' },
    });
  } catch (error) {
    if (verified) { try { await removeFixtures(); } catch { /* Report only the safe error below. */ } }
    if (db) { try { await db.$disconnect(); } catch { /* Report only the safe error below. */ } }
    safeFailure(error);
  }
});

// Exact ids only; do not remove rows belonging to anything else.
async function removeFixtures(): Promise<void> {
  const ids = [...villageIds.values()];
  await db.villageName.deleteMany({ where: { id: { in: nameIds } } });
  await db.village.deleteMany({ where: { id: { in: ids } } });
  await db.governorate.deleteMany({ where: { id: governorateId } });
}

afterAll(async () => {
  try {
    if (verified) {
      await removeFixtures();
      const left =
        (await db.village.count({ where: { id: { in: [...villageIds.values()] } } })) +
        (await db.villageName.count({ where: { id: { in: nameIds } } })) +
        (await db.governorate.count({ where: { id: governorateId } }));
      if (left !== 0) throw new Error('Fixtures were not removed');
    }
    if (db) await db.$disconnect();
  } catch (error) { safeFailure(error); }
});

const search = async (term: string, filters: { governorateId?: string } = { governorateId }) => {
  const { items, total } = await repository.findMany({
    filters: { search: term, ...filters },
    sort: { field: 'nameAr', order: 'asc' },
    skip: 0,
    take: 100,
  });
  return { slugs: items.map(item => item.slug).sort(), total };
};

describe('Village search with special characters, with PostgreSQL', () => {
  it('"%" alone finds the name with a percent sign, not every village', safeTest(async () => {
    const inGovernorate = await search('%');
    expect(inGovernorate.slugs).toEqual([slug('percent')]);
    expect(inGovernorate.total).toBe(1);
    // The same without the governorate filter, against everything in this database: still only the percent name.
    const everywhere = await search('%', {});
    expect(everywhere.slugs).toEqual([slug('percent')]);
    expect(everywhere.total).toBe(1);
  }));

  it('"_" finds the name with an underscore, not every village', safeTest(async () => {
    expect((await search('_')).slugs).toEqual([slug('underscore')]);
    expect((await search('_')).total).toBe(1);
  }));

  it('"bei_" matches Bei_ Alpha and not Beit Beta', safeTest(async () => {
    const result = await search('bei_');
    expect(result.slugs).toEqual([slug('underscore')]);
    expect(result.total).toBe(1);
  }));

  it('"100%" and "a\\b" match literally', safeTest(async () => {
    expect((await search('100%')).slugs).toEqual([slug('percent')]);
    expect((await search('a\\b')).slugs).toEqual([slug('backslash')]);
  }));

  it('a backslash next to a percent sign is still literal', safeTest(async () => {
    expect((await search('\\%')).total).toBe(0);
    expect((await search('%\\')).total).toBe(0);
  }));

  it('ordinary searches are unchanged: English, Arabic, an alternate name, a slug, and no match', safeTest(async () => {
    expect((await search(`Beit Beta ${runId}`)).slugs).toEqual([slug('beit')]);
    expect((await search(`beit beta ${runId}`)).slugs).toEqual([slug('beit')]);
    expect((await search(`ألفا ${runId}`)).slugs).toEqual([slug('underscore')]);
    expect((await search(`Dayr Epsilon ${runId}`)).slugs).toEqual([slug('plain')]);
    expect((await search(slug('plain'))).slugs).toEqual([slug('plain')]);
    expect((await search(`zzqnomatch${runId}`)).total).toBe(0);
    // A term that is a plain prefix of several names still finds all of them.
    expect((await search(runId)).slugs).toEqual(
      ['underscore', 'beit', 'percent', 'backslash', 'plain'].map(slug).sort(),
    );
  }));

  it('keeps working together with the governorate filter', safeTest(async () => {
    expect((await search('_', { governorateId })).slugs).toEqual([slug('underscore')]);
    expect((await search('_', { governorateId: randomUUID() })).total).toBe(0);
  }));
});
