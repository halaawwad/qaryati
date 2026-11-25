import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { HeritageService } from '../src/modules/heritage/heritage.service.js';
import { heritageRepository, type HeritageRepository, type HeritageWriteRecord } from '../src/modules/heritage/heritage.repository.js';
const shared = vi.hoisted(() => ({ village: vi.fn(), source: vi.fn(), audit: vi.fn() }));
vi.mock('../src/shared/db.js', () => ({ prisma: {} }));
vi.mock('../src/modules/villages/villages.service.js', () => ({ villageService: { ensureExists: shared.village } }));
vi.mock('../src/modules/sources/sources.service.js', () => ({ sourceService: { getById: shared.source } }));
vi.mock('../src/modules/audit/audit.service.js', () => ({ recordAudit: shared.audit }));
const tx = {} as Prisma.TransactionClient;
const repo = { transaction: vi.fn<HeritageRepository['transaction']>(), create: vi.fn<HeritageRepository['create']>(),
  findForWrite: vi.fn<HeritageRepository['findForWrite']>(), lock: vi.fn<HeritageRepository['lock']>(),
  updateIfVersion: vi.fn<HeritageRepository['updateIfVersion']>(), softDelete: vi.fn<HeritageRepository['softDelete']>(),
  findMany: vi.fn<HeritageRepository['findMany']>(), findById: vi.fn<HeritageRepository['findById']>() };
const service = new HeritageService(repo);
const context = { actorId: 'actor', requestId: 'request', role: 'ADMIN' as const };
let initial: HeritageWriteRecord;
beforeEach(() => {
  vi.resetAllMocks();
  initial = { id: 'item', villageId: 'village', name: 'Original', description: null, category: 'CRAFT', sourceId: 'source',
    verificationStatus: 'PENDING', version: 1, createdAt: new Date(0), updatedAt: new Date(0),
    deletedAt: null, createdById: 'actor', updatedById: 'actor' };
  repo.transaction.mockImplementation(fn => fn(tx));
  repo.findForWrite.mockImplementation(async () => ({ ...initial }));
  repo.updateIfVersion.mockResolvedValue(0);
});
describe('Heritage write service', () => {
  it('reports fresh version after a lost update race without auditing', async () => {
    repo.findForWrite.mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, version: 2 });
    await expect(service.update('item', { version: 1, name: 'New' }, context)).rejects.toMatchObject({ code: 'VERSION_CONFLICT',
      details: [{ field: 'version', message: 'Current version is 2' }] });
    expect(shared.audit).not.toHaveBeenCalled();
  });
  it.each([null, 'deleted'])('returns 404 after losing the guarded write to deletion (%s)', async state => {
    repo.findForWrite.mockResolvedValueOnce(initial).mockResolvedValueOnce(state ? { ...initial, deletedAt: new Date() } : null);
    await expect(service.update('item', { version: 1, name: 'New' }, context)).rejects.toMatchObject({ statusCode: 404 });
    expect(shared.audit).not.toHaveBeenCalled();
  });
  it('checks ownership before version', async () => {
    await expect(service.update('item', { version: 99, name: 'New' }, { ...context, role: 'EDITOR', actorId: 'other' }))
      .rejects.toMatchObject({ code: 'HERITAGE_EDIT_FORBIDDEN' });
    expect(repo.updateIfVersion).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'source'])('does not revalidate omitted/cleared/unchanged source (%s)', async sourceId => {
    repo.updateIfVersion.mockResolvedValue(1);
    await service.update('item', { version: 1, name: 'New', sourceId }, context);
    expect(shared.source).not.toHaveBeenCalled();
  });
  it('checks changed sources in the transaction before writing', async () => {
    shared.source.mockRejectedValue(new Error('missing source'));
    await expect(service.update('item', { version: 1, sourceId: 'replacement' }, context)).rejects.toThrow('missing source');
    expect(shared.source).toHaveBeenCalledWith('replacement', tx);
    expect(repo.updateIfVersion).not.toHaveBeenCalled();
  });
  it('propagates audit failures out of the transaction', async () => {
    repo.updateIfVersion.mockResolvedValue(1); shared.audit.mockRejectedValue(new Error('audit failure'));
    await expect(service.update('item', { version: 1, name: 'New' }, context)).rejects.toThrow('audit failure');
    expect(shared.audit).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'HeritageItem',
      actorId: 'actor', before: expect.objectContaining({ createdAt: '1970-01-01T00:00:00.000Z' }) }), tx);
  });
  it('captures DELETE audit after acquiring the row lock', async () => {
    repo.findForWrite.mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, name: 'Concurrent', version: 2 })
      .mockResolvedValueOnce({ ...initial, name: 'Concurrent', version: 2, deletedAt: new Date(0) });
    repo.softDelete.mockResolvedValue(1); await service.remove('item', context);
    expect(repo.lock.mock.invocationCallOrder[0]).toBeLessThan(repo.findForWrite.mock.invocationCallOrder[1]!);
    expect(shared.audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'DELETE',
      before: expect.objectContaining({ name: 'Concurrent', version: 2, deletedAt: null }),
      after: expect.objectContaining({ name: 'Concurrent', version: 2, deletedAt: '1970-01-01T00:00:00.000Z' }) }), tx);
  });
});
describe('Heritage repository write guards', () => {
  it('guards actual UPDATE by version and active parent/row and reports affected count', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const client = { heritageItem: { updateMany } } as unknown as Prisma.TransactionClient;
    expect(await heritageRepository.updateIfVersion('item', { version: 3, description: null }, 'actor', client)).toBe(0);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'item', version: 3, deletedAt: null, village: { deletedAt: null } },
      data: { description: null, version: { increment: 1 }, verificationStatus: 'PENDING', updatedById: 'actor' } });
  });
  it('soft deletes active rows without incrementing version or physically deleting', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const client = { heritageItem: { updateMany } } as unknown as Prisma.TransactionClient;
    expect(await heritageRepository.softDelete('item', 'actor', client)).toBe(1);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'item', deletedAt: null, village: { deletedAt: null } },
      data: { deletedAt: expect.any(Date), updatedById: 'actor' } });
  });
});
