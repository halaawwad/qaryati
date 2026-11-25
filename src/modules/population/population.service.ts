import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors.js';
import type { Role } from '@prisma/client';
import { buildPaginationMeta, parsePagination } from '../../shared/pagination.js';
import { villageService } from '../villages/villages.service.js';
import { sourceService } from '../sources/sources.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { populationRepository, type PopulationRepository, type PopulationCreateContext } from './population.repository.js';
import type { CreatePopulationInput, ListPopulationQuery, UpdatePopulationInput } from './population.schemas.js';
function snapshot(item: import('./population.repository.js').PopulationDetails) {
 return {id:item.id, villageId:item.villageId, population:item.population, referenceYear:item.referenceYear, referenceDate:item.referenceDate?.toISOString() ?? null, sourceId:item.sourceId, isEstimate:item.isEstimate, isPreferred:item.isPreferred, needsReview:item.needsReview, notes:item.notes, verificationStatus:item.verificationStatus, version:item.version};
}
function anomalous(population: number, baseline: {population: number} | null): boolean {
 return baseline !== null && (!Number.isSafeInteger(baseline.population) || baseline.population <= 0 || Math.abs(population - baseline.population) * 2 > baseline.population);
}
export class PopulationService {
 constructor(private readonly repository: PopulationRepository = populationRepository, private readonly villages: Pick<typeof villageService, 'ensureExists'> = villageService) {}
 async softDelete(id: string, context: PopulationCreateContext & {role: Role}) {
  if (context.role !== 'ADMIN') throw new ForbiddenError();
  const initial = await this.repository.findById(id);
  if (!initial) throw new NotFoundError('Population record not found');
  return this.repository.transaction(async client => {
   await this.villages.ensureExists(initial.villageId, client);
   const current = await this.repository.findForDelete(id, client);
   if (!current || current.villageId !== initial.villageId) throw new NotFoundError('Population record not found');
   const deleted = await this.repository.softDelete(id, context.actorId, client);
   await recordAudit({entityType:'PopulationRecord', entityId:id, action:'DELETE', actorId:context.actorId, requestId:context.requestId,
    before:{...snapshot(current), createdById:current.createdById, updatedById:current.updatedById, verifiedById:current.verifiedById, verifiedAt:current.verifiedAt?.toISOString() ?? null, deletedAt:null},
    after:{...snapshot(deleted), createdById:deleted.createdById, updatedById:deleted.updatedById, verifiedById:deleted.verifiedById, verifiedAt:deleted.verifiedAt?.toISOString() ?? null, deletedAt:deleted.deletedAt?.toISOString() ?? null}}, client);
   return {id:deleted.id, version:deleted.version, deletedAt:deleted.deletedAt};
  });
 }
 async update(id: string, input: UpdatePopulationInput, context: PopulationCreateContext & {role: Role}) {
  const initial = await this.repository.findById(id);
  if (!initial) throw new NotFoundError('Population record not found');
  return this.repository.transaction(async client => {
   await this.villages.ensureExists(initial.villageId, client);
   // Keep the source lock before the population lock, but defer a missing-source
   // response until authorization has been checked against the locked record.
   let missingSource: NotFoundError | undefined;
   if (input.sourceId !== undefined && input.sourceId !== initial.sourceId) {
    try { await sourceService.getById(input.sourceId, client); }
    catch (error) { if (error instanceof NotFoundError) missingSource = error; else throw error; }
   }
   const current = await this.repository.findForUpdate(id, client);
   if (!current || current.villageId !== initial.villageId || current.sourceId !== initial.sourceId) throw new ConflictError('Population record changed during update');
   const allowed = context.role === 'EDITOR' ? current.verificationStatus === 'PENDING' && current.createdById === context.actorId : (context.role === 'REVIEWER' || context.role === 'ADMIN') && (current.verificationStatus === 'PENDING' || current.verificationStatus === 'VERIFIED');
   if (!allowed) throw new ForbiddenError('Direct editing is not permitted for this population record');
   if (missingSource) throw missingSource;
   if (current.version !== input.expectedVersion) throw new ConflictError('Population record version conflict');
   const {createdById: _creator, ...before} = current;
   const {expectedVersion: _version, ...changes} = input;
   const changed = Object.entries(changes).some(([key, value]) => {
    if (value === undefined) return false;
    if (key === 'referenceDate') return (value === null ? null : new Date(value as string).getTime()) !== (before.referenceDate?.getTime() ?? null);
    return value !== before[key as keyof typeof before];
   });
   if (!changed) return before;
   let needsReview: boolean | undefined;
   if (input.population !== undefined && input.population !== current.population) {
    const baseline = await this.repository.findLatestVerified(current.villageId, client, id);
    needsReview = current.needsReview || anomalous(input.population, baseline);
   }
   const item = await this.repository.update(id, input, context.actorId, client, needsReview);
   await recordAudit({entityType:'PopulationRecord', entityId:id, action:'UPDATE', actorId:context.actorId, requestId:context.requestId, before:snapshot(before), after:snapshot(item)}, client);
   return item;
  });
 }
 async create(villageId: string, input: CreatePopulationInput, context: PopulationCreateContext) {
  await this.villages.ensureExists(villageId);
  await sourceService.getById(input.sourceId);
  return this.repository.transaction(async client => {
   await this.villages.ensureExists(villageId, client);
   await sourceService.getById(input.sourceId, client);
   const baseline = await this.repository.findLatestVerified(villageId, client);
   const needsReview = anomalous(input.population, baseline);
   const item = await this.repository.create(villageId, input, needsReview, context, client);
   await recordAudit({ entityType: 'PopulationRecord', entityId: item.id, action: 'CREATE', actorId: context.actorId, requestId: context.requestId, before: null,
    after: { id: item.id, villageId: item.villageId, population: item.population, referenceYear: item.referenceYear, referenceDate: item.referenceDate?.toISOString() ?? null, sourceId: item.sourceId, isEstimate: item.isEstimate, isPreferred: item.isPreferred, needsReview: item.needsReview, notes: item.notes, verificationStatus: item.verificationStatus, version: item.version },
   }, client);
   return item;
  });
 }
 async list(villageId: string, query: ListPopulationQuery) {
  await this.villages.ensureExists(villageId);
  const pagination = parsePagination(query);
  const {referenceYear, sourceId, isEstimate, isPreferred, needsReview, verificationStatus} = query;
  const result = await this.repository.findMany({villageId, filters: {referenceYear, sourceId, isEstimate, isPreferred, needsReview, verificationStatus}, sort: {field: query.sort ?? 'referenceYear', order: query.order ?? 'desc'}, skip: pagination.skip, take: pagination.take});
  if (result.items.length === 0) await this.villages.ensureExists(villageId);
  return {items: result.items, meta: buildPaginationMeta(result.total, pagination)};
 }
 async getById(id: string) { const item = await this.repository.findById(id); if (!item) throw new NotFoundError('Population record not found'); return item; }
}
export const populationService = new PopulationService();
