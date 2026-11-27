import { randomUUID } from 'node:crypto';
import type { PrismaClient as PrismaClientType } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Safe setup: start a fresh disposable PostgreSQL instance with temporary
// credentials and tmpfs-only storage at the guarded address below. Verify its
// container, mounts, port, database identity and empty schema before migrations.
// In that instance only, create schema qaryati_test_safety and table
// qaryati_test_safety.disposable_instance (marker uuid NOT NULL); insert exactly
// one newly generated UUID v4, then set QARYATI_DISPOSABLE_MARKER to that value
// for this run. Never provision the marker in a persistent database. This test
// only reads it; the external runner owns removal of the disposable instance.

const markerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Identity = { database: string; username: string };
type Marker = { marker: string };

async function verifyDisposable(client: PrismaClientType, marker: string | undefined): Promise<void> {
  if (!marker || !markerPattern.test(marker)) throw new Error('A unique disposable-instance marker is required');
  const identity = await client.$queryRaw<Identity[]>`SELECT current_database() AS database, current_user AS username`;
  if (identity.length !== 1 || identity[0]?.database !== 'qaryati_local' || identity[0]?.username !== 'qaryati_local') throw new Error('Unexpected database identity');
  let rows: Marker[];
  try {
    rows = await client.$queryRaw<Marker[]>`SELECT marker::text AS marker FROM qaryati_test_safety.disposable_instance LIMIT 2`;
  } catch {
    throw new Error('Disposable-instance marker is unavailable');
  }
  if (rows.length !== 1 || rows[0]?.marker.toLowerCase() !== marker.toLowerCase()) throw new Error('Disposable-instance marker does not match');
}

async function initializeVerified(client: PrismaClientType, marker: string | undefined, onVerified: () => void, initialize: () => Promise<void>): Promise<void> {
  await verifyDisposable(client, marker);
  onVerified();
  await initialize();
}

async function cleanupIfVerified(verified: boolean, actions: Array<() => Promise<unknown>>, attempt: (action: () => Promise<unknown>) => Promise<void>): Promise<void> {
  if (verified) for (const action of actions) await attempt(action);
}

describe('disposable database guard', () => {
  it('rejects a missing marker before any fixture write or cleanup', async () => {
    const query = vi.fn();
    const fixtureWrite = vi.fn();
    const fixtureDelete = vi.fn();
    const markVerified = vi.fn();
    await expect(initializeVerified({$queryRaw: query} as unknown as PrismaClientType, undefined, markVerified, fixtureWrite)).rejects.toThrow('marker is required');
    await cleanupIfVerified(markVerified.mock.calls.length > 0, [fixtureDelete], async action => { await action(); });
    expect(query).not.toHaveBeenCalled();
    expect(markVerified).not.toHaveBeenCalled();
    expect(fixtureWrite).not.toHaveBeenCalled();
    expect(fixtureDelete).not.toHaveBeenCalled();
  });

  it('rejects a mismatched marker before any fixture write or cleanup', async () => {
    const query = vi.fn().mockResolvedValueOnce([{database:'qaryati_local',username:'qaryati_local'}]).mockResolvedValueOnce([{marker:randomUUID()}]);
    const fixtureWrite = vi.fn();
    const fixtureDelete = vi.fn();
    const markVerified = vi.fn();
    await expect(initializeVerified({$queryRaw: query} as unknown as PrismaClientType, randomUUID(), markVerified, fixtureWrite)).rejects.toThrow('marker does not match');
    await cleanupIfVerified(markVerified.mock.calls.length > 0, [fixtureDelete], async action => { await action(); });
    expect(query).toHaveBeenCalledTimes(2);
    expect(markVerified).not.toHaveBeenCalled();
    expect(fixtureWrite).not.toHaveBeenCalled();
    expect(fixtureDelete).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid marker', 'invalid', undefined],
    ['missing marker row', randomUUID(), []],
    ['multiple marker rows', randomUUID(), [{marker:randomUUID()},{marker:randomUUID()}]],
  ])('rejects %s without enabling writes or cleanup', async (_label, marker, rows) => {
    const query = vi.fn().mockResolvedValueOnce([{database:'qaryati_local',username:'qaryati_local'}]).mockResolvedValueOnce(rows);
    const fixtureWrite = vi.fn();
    const markVerified = vi.fn();
    await expect(initializeVerified({$queryRaw: query} as unknown as PrismaClientType, marker, markVerified, fixtureWrite)).rejects.toThrow();
    expect(markVerified).not.toHaveBeenCalled();
    expect(fixtureWrite).not.toHaveBeenCalled();
  });
});

describe('submission with a constrained pool', () => {
  let setup: PrismaClientType | undefined;
  let constrained: PrismaClientType | undefined;
  let verified = false;
  let submit: typeof import('../../src/modules/change-requests/change-requests.service.js').changeRequestsService.submit;
  let approve: typeof import('../../src/modules/change-requests/change-requests.service.js').changeRequestsService.approve;
  const ids = { actor: randomUUID(), reviewer: randomUUID(), governorate: randomUUID(), village: randomUUID(), source: randomUUID(), population: randomUUID() };

  beforeAll(async () => {
    if (process.env.QARYATI_POSTGRES_INTEGRATION !== '1') throw new Error('PostgreSQL integration opt-in required');
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '55433' || url.pathname !== '/qaryati_local' || url.username !== 'qaryati_local' || url.hash || [...url.searchParams.keys()].some(key => key !== 'schema') || (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')) throw new Error('Unexpected database target');
    const { PrismaClient } = await import('@prisma/client');
    setup = new PrismaClient();
    await initializeVerified(setup, process.env.QARYATI_DISPOSABLE_MARKER, () => { verified = true; }, async () => {
      await setup!.user.create({data:{id:ids.actor,email:`${ids.actor}@integration.invalid`,fullName:'Fixture',passwordHash:'unused',role:'EDITOR'}});
      await setup!.user.create({data:{id:ids.reviewer,email:`${ids.reviewer}@integration.invalid`,fullName:'Reviewer fixture',passwordHash:'unused',role:'REVIEWER'}});
      await setup!.governorate.create({data:{id:ids.governorate,nameAr:`ar-${ids.governorate}`,nameEn:`en-${ids.governorate}`,code:`i-${ids.governorate}`}});
      await setup!.village.create({data:{id:ids.village,governorateId:ids.governorate,slug:`integration-${ids.village}`,nameAr:'Fixture'}});
      await setup!.source.create({data:{id:ids.source,title:'Fixture',sourceType:'BOOK'}});
      await setup!.populationRecord.create({data:{id:ids.population,villageId:ids.village,sourceId:ids.source,population:100,referenceYear:2020,verificationStatus:'VERIFIED',version:3}});
    });
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('pool_timeout', '2');
    constrained = new PrismaClient({datasources:{db:{url:url.toString()}}});
    vi.stubEnv('NODE_ENV','test'); vi.stubEnv('LOG_LEVEL','silent'); vi.stubEnv('REDIS_URL','redis://127.0.0.1:6379'); vi.stubEnv('JWT_ACCESS_SECRET','integration-test-secret-at-least-32-characters');
    vi.doMock('../../src/shared/db.js', () => ({ prisma: constrained }));
    vi.doMock('../../src/shared/cache.js', () => ({ redis: {} }));
    submit = (await import('../../src/modules/change-requests/change-requests.service.js')).changeRequestsService.submit;
    approve = (await import('../../src/modules/change-requests/change-requests.service.js')).changeRequestsService.approve;
  }, 15000);

  afterAll(async () => {
    const errors: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { errors.push(error); } };
    try {
      if (setup) {
        const db = setup;
        await cleanupIfVerified(verified, [
          () => db.auditLog.deleteMany({where:{actorId:{in:[ids.actor,ids.reviewer]}}}),
          () => db.changeRequest.deleteMany({where:{requestedById:ids.actor}}),
          () => db.populationRecord.deleteMany({where:{id:ids.population}}),
          () => db.village.deleteMany({where:{id:ids.village}}),
          () => db.source.deleteMany({where:{id:ids.source}}),
          () => db.governorate.deleteMany({where:{id:ids.governorate}}),
          () => db.user.deleteMany({where:{id:ids.actor}}),
          () => db.user.deleteMany({where:{id:ids.reviewer}}),
        ], attempt);
      }
    } finally {
      if (constrained) await attempt(() => constrained!.$disconnect());
      if (setup) await attempt(() => setup!.$disconnect());
      for (const restore of [
        () => vi.restoreAllMocks(),
        () => vi.doUnmock('../../src/shared/db.js'),
        () => vi.doUnmock('../../src/shared/cache.js'),
        () => vi.unstubAllEnvs(),
        () => vi.resetModules(),
      ]) {
        try { restore(); } catch (error) { errors.push(error); }
      }
    }
    // Vitest reports this afterAll failure separately from an earlier test/setup failure.
    if (errors.length) throw new AggregateError(errors, 'Fixture cleanup or restoration failed');
  }, 15000);

  it('submits and audits with one pooled connection', async () => {
    expect((await import('../../src/shared/db.js')).prisma).toBe(constrained);
    const requestId = randomUUID();
    const result = await submit({entityType:'PopulationRecord',entityId:ids.population,baseVersion:3,proposedChanges:{population:150}}, {actorId:ids.actor,role:'EDITOR',requestId});
    expect(result.status).toBe('PENDING');
    expect(await setup!.changeRequest.findUnique({where:{id:result.id}})).toMatchObject({status:'PENDING',entityId:ids.population,baseVersion:3});
    expect(await setup!.auditLog.count({where:{entityId:result.id,requestId,action:'CREATE'}})).toBe(1);
  }, 10000);

  it('approves and records both audits with one pooled connection', async () => {
    expect((await import('../../src/shared/db.js')).prisma).toBe(constrained);
    const pending=await submit({entityType:'PopulationRecord',entityId:ids.population,baseVersion:3,proposedChanges:{population:150}}, {actorId:ids.actor,role:'EDITOR',requestId:randomUUID()});
    const requestId=randomUUID();
    const result=await approve(pending.id,{}, {actorId:ids.reviewer,role:'REVIEWER',requestId});
    expect(result).toMatchObject({status:'APPROVED',reviewedById:ids.reviewer,reviewComment:null});
    expect(await setup!.populationRecord.findUnique({where:{id:ids.population}})).toMatchObject({population:150,version:4,verificationStatus:'VERIFIED',updatedById:ids.reviewer});
    expect(await setup!.changeRequest.findUnique({where:{id:pending.id}})).toMatchObject({status:'APPROVED',reviewedById:ids.reviewer});
    const audits=await setup!.auditLog.findMany({where:{requestId},orderBy:{entityType:'asc'}});
    expect(audits).toHaveLength(2);
    expect(audits.map(audit=>[audit.entityType,audit.action])).toEqual([['ChangeRequest','APPROVE'],['PopulationRecord','UPDATE']]);
  }, 10000);
});
