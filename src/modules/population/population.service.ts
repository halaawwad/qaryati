import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { Prisma, type Role } from '@prisma/client';
import { buildPaginationMeta, parsePagination } from '../../shared/pagination.js';
import { villageService } from '../villages/villages.service.js';
import { sourceService } from '../sources/sources.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { populationRepository, type PopulationRepository, type PopulationCreateContext } from './population.repository.js';
import { populationProposalSchema } from './population.schemas.js';
import type { CreatePopulationInput, ListPopulationQuery, UpdatePopulationInput, ReviewPopulationInput, SelectPreferredInput } from './population.schemas.js';
function snapshot(item: import('./population.repository.js').PopulationDetails) {
 return {id:item.id, villageId:item.villageId, population:item.population, referenceYear:item.referenceYear, referenceDate:item.referenceDate?.toISOString() ?? null, sourceId:item.sourceId, isEstimate:item.isEstimate, isPreferred:item.isPreferred, needsReview:item.needsReview, notes:item.notes, verificationStatus:item.verificationStatus, version:item.version};
}
function anomalous(population: number, baseline: {population: number} | null): boolean {
 return baseline !== null && (!Number.isSafeInteger(baseline.population) || baseline.population <= 0 || Math.abs(population - baseline.population) * 2 > baseline.population);
}
function ensureVersionCapacity(version: number): void {
 if (version >= 2147483647) throw new ConflictError('Population record version exhausted');
}
function hasChanges(before: import('./population.repository.js').PopulationDetails, changes: Omit<UpdatePopulationInput, 'expectedVersion'>): boolean {
 return Object.entries(changes).some(([key, value]) => {
  if (value === undefined) return false;
  if (key === 'referenceDate') return (value === null ? null : new Date(value as string).getTime()) !== (before.referenceDate?.getTime() ?? null);
  return value !== before[key as keyof typeof before];
 });
}
export class PopulationService {
 constructor(private readonly repository: PopulationRepository = populationRepository, private readonly villages: Pick<typeof villageService, 'ensureExists'> = villageService) {}
 async applyApprovedChange(id:string, baseVersion:number, proposedChanges:unknown, actorId:string, client:Prisma.TransactionClient) {
  const parsed=populationProposalSchema.safeParse(proposedChanges);
  if (!parsed.success) throw new ConflictError('Invalid stored population proposal');
  const changes=parsed.data;
  const initial=await this.repository.findById(id,client);
  if (!initial) throw new NotFoundError('Population record not found');
  await this.villages.ensureExists(initial.villageId,client);
  let missingSource:NotFoundError | undefined;
  if (changes.sourceId !== undefined && changes.sourceId.toLowerCase() !== initial.sourceId.toLowerCase()) {
   try { await sourceService.getById(changes.sourceId,client); }
   catch (error) { if (error instanceof NotFoundError) missingSource=error; else throw error; }
  }
  const current=await this.repository.findForDelete(id,client);
  if (!current) throw new NotFoundError('Population record not found');
  if (current.villageId !== initial.villageId || current.sourceId !== initial.sourceId) throw new ConflictError('Population record changed during approval');
  if (current.verificationStatus !== 'VERIFIED') throw new ConflictError('Only verified population records can be approved');
  if (current.version !== baseVersion) throw new ConflictError('Population record version conflict');
  if (missingSource) throw missingSource;
  const normalized={...changes};
  if (normalized.sourceId?.toLowerCase() === current.sourceId.toLowerCase()) normalized.sourceId=current.sourceId;
  if (!hasChanges(current,normalized)) throw new ConflictError('Proposal must change at least one field');
  ensureVersionCapacity(current.version);
  let needsReview:boolean | undefined;
  if (normalized.population !== undefined && normalized.population !== current.population) {
   const baseline=await this.repository.findLatestVerified(current.villageId,client,id);
   needsReview=current.needsReview || anomalous(normalized.population,baseline);
  }
  await this.repository.update(id,{expectedVersion:baseVersion,...normalized},actorId,client,needsReview);
  const after=await this.repository.findForDelete(id,client);
  if (!after) throw new ConflictError('Population record changed during approval');
  const auditSnapshot=(record:typeof current) => ({...snapshot(record),createdById:record.createdById,updatedById:record.updatedById,verifiedById:record.verifiedById,verifiedAt:record.verifiedAt?.toISOString() ?? null});
  return {before:auditSnapshot(current),after:auditSnapshot(after)};
 }
 async validateChangeProposal(id: string, input: UpdatePopulationInput, client: Prisma.TransactionClient): Promise<void> {
  const initial = await this.repository.findById(id, client);
  if (!initial) throw new NotFoundError('Population record not found');
  await this.villages.ensureExists(initial.villageId, client);
  let missingSource: NotFoundError | undefined;
  if (input.sourceId !== undefined && input.sourceId.toLowerCase() !== initial.sourceId.toLowerCase()) {
   try { await sourceService.getById(input.sourceId, client); }
   catch (error) { if (error instanceof NotFoundError) missingSource = error; else throw error; }
  }
  const current = await this.repository.findForUpdate(id, client);
  if (!current) throw new NotFoundError('Population record not found');
  if (current.villageId !== initial.villageId || current.sourceId !== initial.sourceId) throw new ConflictError('Population record changed during submission');
  if (current.verificationStatus !== 'VERIFIED') throw new ConflictError('Only verified population records can be proposed');
  if (missingSource) throw missingSource;
  if (current.version !== input.expectedVersion) throw new ConflictError('Population record version conflict');
  const {expectedVersion: _version, ...changes} = input;
  if (changes.sourceId?.toLowerCase() === current.sourceId.toLowerCase()) changes.sourceId = current.sourceId;
  if (!hasChanges(current, changes)) throw new ValidationError('Proposal must change at least one field');
  ensureVersionCapacity(current.version);
 }
 async selectPreferred(id: string, input: SelectPreferredInput, context: PopulationCreateContext & {role: Role}) {
  if (context.role !== 'REVIEWER' && context.role !== 'ADMIN') throw new ForbiddenError();
  const initial = await this.repository.findById(id);
  if (!initial) throw new NotFoundError('Population record not found');
  try {
   return await this.repository.preferredTransaction(async client => {
    await this.villages.ensureExists(initial.villageId, client);
    await this.repository.lockPreferredGroup(initial.villageId, initial.referenceYear, client);
    const candidate = await this.repository.findPreferredSlot(initial.villageId, initial.referenceYear, client);
    const rows = await this.repository.lockPreferredRows([initial.id, ...(candidate ? [candidate.id] : [])], client);
    const target = rows.find(row => row.id === initial.id);
    if (!target || target.deletedAt) throw new NotFoundError('Population record not found');
    if (target.villageId !== initial.villageId || target.referenceYear !== initial.referenceYear) throw new ConflictError('Population record changed during selection');
    const currentSlot = await this.repository.findPreferredSlot(initial.villageId, initial.referenceYear, client);
    if ((candidate?.id ?? null) !== (currentSlot?.id ?? null)) throw new ConflictError('Population preferred record changed during selection');
    const previous = currentSlot ? rows.find(row => row.id === currentSlot.id) : undefined;
    if (currentSlot && (!previous || previous.deletedAt || !previous.isPreferred || previous.villageId !== initial.villageId || previous.referenceYear !== initial.referenceYear || previous.version !== currentSlot.version)) throw new ConflictError('Population preferred record changed during selection');
    if (target.verificationStatus !== 'VERIFIED') throw new ConflictError('Only verified population records can be preferred');
    if (target.version !== input.expectedVersion) throw new ConflictError('Population record version conflict');
    const expected = input.expectedPreferred;
    if ((!expected && currentSlot) || (expected && (!previous || expected.id.toLowerCase() !== previous.id.toLowerCase() || expected.version !== previous.version))) throw new ConflictError('Population preferred record version conflict');
    const publicRecord = (item: import('./population.repository.js').PopulationSnapshot) => {
     const {createdById: _createdById, updatedById: _updatedById, verifiedById: _verifiedById, verifiedAt: _verifiedAt, ...details} = item;
     return details;
    };
    if (target.isPreferred) {
     if (!previous || previous.id !== target.id) throw new ConflictError('Population preferred record changed during selection');
     const {deletedAt: _deletedAt, ...record} = target;
     return publicRecord(record);
    }
    ensureVersionCapacity(target.version);
    if (previous) ensureVersionCapacity(previous.version);
    const auditSnapshot = (record: import('./population.repository.js').PopulationSnapshot) => ({...snapshot(record),createdById:record.createdById,updatedById:record.updatedById,verifiedById:record.verifiedById,verifiedAt:record.verifiedAt?.toISOString() ?? null});
    const demoted = previous ? await this.repository.setPreferred(previous.id, previous.version, true, context.actorId, client) : undefined;
    const selected = await this.repository.setPreferred(target.id, target.version, false, context.actorId, client);
    if (previous && demoted) await recordAudit({entityType:'PopulationRecord',entityId:previous.id,action:'UPDATE',actorId:context.actorId,requestId:context.requestId,before:auditSnapshot(previous),after:auditSnapshot(demoted)},client);
    await recordAudit({entityType:'PopulationRecord',entityId:target.id,action:'UPDATE',actorId:context.actorId,requestId:context.requestId,before:auditSnapshot(target),after:auditSnapshot(selected)},client);
    return publicRecord(selected);
   });
  } catch (error) {
   if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || (error.code === 'P2010' && (error.meta?.code === '40P01' || error.meta?.code === '40001')))) throw new ConflictError('Population selection concurrency conflict');
   throw error;
  }
 }
 async review(id: string, input: ReviewPopulationInput, target: 'VERIFIED' | 'REJECTED', context: PopulationCreateContext & {role: Role}) {
  if (context.role !== 'REVIEWER' && context.role !== 'ADMIN') throw new ForbiddenError();
  const initial = await this.repository.findById(id);
  if (!initial) throw new NotFoundError('Population record not found');
  return this.repository.transaction(async client => {
   await this.villages.ensureExists(initial.villageId, client);
   const current = await this.repository.findForDelete(id, client);
   if (!current || current.villageId !== initial.villageId) throw new NotFoundError('Population record not found');
   if (current.version !== input.expectedVersion) throw new ConflictError('Population record version conflict');
   const publicRecord = (item: typeof current) => {
    const {createdById: _createdById, updatedById: _updatedById, verifiedById: _verifiedById, verifiedAt: _verifiedAt, ...details} = item;
    return details;
   };
   if (current.verificationStatus === target) return publicRecord(current);
   ensureVersionCapacity(current.version);
   const item = await this.repository.review(id, input.expectedVersion, current.verificationStatus, target, context.actorId, client);
   const auditSnapshot = (record: typeof current) => ({...snapshot(record), createdById:record.createdById, updatedById:record.updatedById, verifiedById:record.verifiedById, verifiedAt:record.verifiedAt?.toISOString() ?? null});
   await recordAudit({entityType:'PopulationRecord', entityId:id, action:target === 'VERIFIED' ? 'VERIFY' : 'REJECT', actorId:context.actorId, requestId:context.requestId, before:auditSnapshot(current), after:auditSnapshot(item)}, client);
   return publicRecord(item);
  });
 }
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
   const changed = hasChanges(before, changes);
   if (!changed) return before;
   ensureVersionCapacity(current.version);
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
  const {referenceYear, sourceId, isEstimate, needsReview, verificationStatus} = query;
  const isPreferred = query.includeAll ? undefined : query.isPreferred ?? true;
  const result = await this.repository.findMany({villageId, filters: {referenceYear, sourceId, isEstimate, isPreferred, needsReview, verificationStatus}, sort: {field: query.sort ?? 'referenceYear', order: query.order ?? 'desc'}, skip: pagination.skip, take: pagination.take});
  if (result.items.length === 0) await this.villages.ensureExists(villageId);
  return {items: result.items, meta: buildPaginationMeta(result.total, pagination)};
 }
 async getById(id: string) { const item = await this.repository.findById(id); if (!item) throw new NotFoundError('Population record not found'); return item; }
}
export const populationService = new PopulationService();
