import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { EventService } from '../src/modules/events/events.service.js';
import type { EventRepository, EventWriteRecord } from '../src/modules/events/events.repository.js';
const shared = vi.hoisted(() => ({ village: vi.fn(), source: vi.fn(), audit: vi.fn() }));
vi.mock('../src/shared/db.js', () => ({ prisma: {} }));
vi.mock('../src/modules/villages/villages.service.js', () => ({ villageService: { ensureExists: shared.village } }));
vi.mock('../src/modules/sources/sources.service.js', () => ({ sourceService: { getById: shared.source } }));
vi.mock('../src/modules/audit/audit.service.js', () => ({ recordAudit: shared.audit }));
const tx = {} as Prisma.TransactionClient;
const repo = { transaction: vi.fn<EventRepository['transaction']>(), create: vi.fn<EventRepository['create']>(),
  findForWrite: vi.fn<EventRepository['findForWrite']>(), lock: vi.fn<EventRepository['lock']>(),
  updateIfVersion: vi.fn<EventRepository['updateIfVersion']>(), softDelete: vi.fn<EventRepository['softDelete']>(),
  findMany: vi.fn<EventRepository['findMany']>(), findById: vi.fn<EventRepository['findById']>() };
const service = new EventService(repo);
const context = { actorId: 'actor', requestId: 'request', role: 'ADMIN' as const };
let initial: EventWriteRecord;
beforeEach(() => {
  vi.resetAllMocks();
  initial = { id: 'event', villageId: 'village', title: 'Original', description: null, eventYear: -100,
    eventDate: null, category: null, sourceId: 'source', isApproximate: true, verificationStatus: 'PENDING', version: 1,
    createdAt: new Date(0), updatedAt: new Date(0), deletedAt: null, createdById: 'actor', updatedById: 'actor' };
  repo.transaction.mockImplementation(fn => fn(tx));
  repo.findForWrite.mockImplementation(async () => ({ ...initial }));
  repo.updateIfVersion.mockResolvedValue(0);
});
describe('Event write service conflict and audit boundaries', () => {
  it('reports the fresh version if the guarded update loses a race', async () => {
    repo.findForWrite.mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, version: 2 });
    await expect(service.update('event', { version: 1, title: 'New' }, context)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT', details: [{ field: 'version', message: 'Current version is 2' }],
    });
    expect(shared.audit).not.toHaveBeenCalled();
  });
  it.each([null, 'deleted'])('returns 404 if guarded update loses to deletion (%s)', async state => {
    repo.findForWrite.mockResolvedValueOnce(initial).mockResolvedValueOnce(state ? { ...initial, deletedAt: new Date() } : null);
    await expect(service.update('event', { version: 1, title: 'New' }, context)).rejects.toMatchObject({ statusCode: 404 });
    expect(shared.audit).not.toHaveBeenCalled();
  });
  it('checks editor authorization before version and never writes on rejection', async () => {
    await expect(service.update('event', { version: 99, title: 'New' }, { ...context, role: 'EDITOR', actorId: 'other' }))
      .rejects.toMatchObject({ code: 'EVENT_EDIT_FORBIDDEN' });
    expect(repo.updateIfVersion).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'source'])('does not revalidate omitted, cleared or unchanged source (%s)', async sourceId => {
    repo.updateIfVersion.mockResolvedValue(1);
    await service.update('event', { version: 1, title: 'New', sourceId }, context);
    expect(shared.source).not.toHaveBeenCalled();
  });
  it('validates a changed source through the shared service in the transaction', async () => {
    shared.source.mockRejectedValue(new Error('missing source'));
    await expect(service.update('event', { version: 1, sourceId: 'replacement' }, context)).rejects.toThrow('missing source');
    expect(shared.source).toHaveBeenCalledWith('replacement', tx);
    expect(repo.updateIfVersion).not.toHaveBeenCalled();
  });
  it('propagates audit errors out of the transaction and serializes dates', async () => {
    repo.updateIfVersion.mockResolvedValue(1);
    shared.audit.mockRejectedValue(new Error('audit failure'));
    await expect(service.update('event', { version: 1, title: 'New' }, context)).rejects.toThrow('audit failure');
    expect(shared.audit).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'HistoricalEvent', actorId: 'actor', before: expect.objectContaining({ createdAt: '1970-01-01T00:00:00.000Z' }),
    }), tx);
  });
  it('rereads the DELETE snapshot after locking to capture a completed edit', async () => {
    repo.findForWrite.mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ...initial, title: 'Concurrent', version: 2 })
      .mockResolvedValueOnce({ ...initial, title: 'Concurrent', version: 2, deletedAt: new Date(0) });
    repo.softDelete.mockResolvedValue(1);
    await service.remove('event', context);
    expect(repo.lock.mock.invocationCallOrder[0]).toBeLessThan(repo.findForWrite.mock.invocationCallOrder[1]!);
    expect(shared.audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'DELETE',
      before: expect.objectContaining({ title: 'Concurrent', version: 2, deletedAt: null }),
      after: expect.objectContaining({ title: 'Concurrent', version: 2, deletedAt: '1970-01-01T00:00:00.000Z' }),
    }), tx);
  });
});
