import { Prisma, type PopulationRecord, type VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import { ConflictError, NotFoundError } from '../../shared/errors.js';
import type { CreatePopulationInput, UpdatePopulationInput } from './population.schemas.js';
export interface PopulationCreateContext { actorId: string; requestId: string }
export type PopulationDetails = Pick<PopulationRecord, 'id' | 'villageId' | 'population' | 'referenceYear' | 'referenceDate' | 'sourceId' | 'isEstimate' | 'isPreferred' | 'needsReview' | 'notes' | 'verificationStatus' | 'version' | 'createdAt' | 'updatedAt'>;
export interface PopulationListParams {
 villageId: string; filters: { referenceYear?: number; sourceId?: string; isEstimate?: boolean; isPreferred?: boolean; needsReview?: boolean; verificationStatus?: VerificationStatus };
 sort: { field: 'referenceYear' | 'population' | 'createdAt' | 'updatedAt'; order: 'asc' | 'desc' }; skip: number; take: number;
}
type DeleteSnapshot = PopulationDetails & Pick<PopulationRecord, 'createdById' | 'updatedById' | 'verifiedById' | 'verifiedAt'>;
export interface PopulationRepository { transaction<T>(fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T>; findLatestVerified(villageId: string, client: Prisma.TransactionClient, excludeId?: string): Promise<{population: number} | null>; create(villageId: string, input: CreatePopulationInput, needsReview: boolean, context: PopulationCreateContext, client: Prisma.TransactionClient): Promise<PopulationDetails>; findForUpdate(id: string, client: Prisma.TransactionClient): Promise<(PopulationDetails & {createdById: string | null}) | null>; findForDelete(id: string, client: Prisma.TransactionClient): Promise<DeleteSnapshot | null>; review(id: string, expectedVersion: number, currentStatus: VerificationStatus, target: 'VERIFIED' | 'REJECTED', actorId: string, client: Prisma.TransactionClient): Promise<DeleteSnapshot>; softDelete(id: string, actorId: string, client: Prisma.TransactionClient): Promise<DeleteSnapshot & {deletedAt: Date | null}>; update(id: string, input: UpdatePopulationInput, actorId: string, client: Prisma.TransactionClient, needsReview?: boolean): Promise<PopulationDetails>; findMany(params: PopulationListParams): Promise<{ items: PopulationDetails[]; total: number }>; findById(id: string): Promise<PopulationDetails | null> }
const select = { id: true, villageId: true, population: true, referenceYear: true, referenceDate: true, sourceId: true, isEstimate: true, isPreferred: true, needsReview: true, notes: true, verificationStatus: true, version: true, createdAt: true, updatedAt: true } satisfies Prisma.PopulationRecordSelect;
const deleteSelect = {...select, createdById: true, updatedById: true, verifiedById: true, verifiedAt: true} satisfies Prisma.PopulationRecordSelect;
const active = { deletedAt: null, village: { deletedAt: null } } satisfies Prisma.PopulationRecordWhereInput;
function isPopulationBusinessKeyConflict(error: unknown): boolean {
 if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002' || !error.meta) return false;
 if (error.meta.modelName !== undefined && error.meta.modelName !== 'PopulationRecord') return false;
 const target = error.meta.target;
 if (target === 'population_records_village_id_reference_year_source_id_key') return true;
 if (!Array.isArray(target) || target.length !== 3 || !target.every(field => typeof field === 'string')) return false;
 const fields = [...target].sort().join(',');
 return fields === ['village_id', 'reference_year', 'source_id'].sort().join(',') ||
  fields === ['villageId', 'referenceYear', 'sourceId'].sort().join(',');
}
function isPreferredIndexConflict(error: unknown): boolean {
 return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' &&
  (error.meta?.modelName === undefined || error.meta.modelName === 'PopulationRecord') &&
  error.meta?.target === 'population_records_one_preferred_per_year_idx';
}
export const populationRepository: PopulationRepository = {
 transaction(fn) { return prisma.$transaction(fn); },
 async findForUpdate(id, client) {
  const rows = await client.$queryRaw<{id: string}[]>`SELECT id FROM population_records WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
  if (!rows.length) return null;
  return client.populationRecord.findFirst({where: {id, deletedAt: null}, select: {...select, createdById: true}});
 },
 async findForDelete(id, client) {
  const rows = await client.$queryRaw<{id: string}[]>`SELECT id FROM population_records WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
  if (!rows.length) return null;
  return client.populationRecord.findFirst({where: {id, deletedAt: null}, select: deleteSelect});
 },
 async review(id, expectedVersion, currentStatus, target, actorId, client) {
  try {
   return await client.populationRecord.update({
    where: {id, deletedAt: null, version: expectedVersion, verificationStatus: currentStatus},
    data: {verificationStatus: target, verifiedById: target === 'VERIFIED' ? actorId : null,
     verifiedAt: target === 'VERIFIED' ? new Date() : null, updatedById: actorId,
     ...(target === 'REJECTED' ? {isPreferred: false} : {}), version: {increment: 1}},
    select: deleteSelect,
   });
  } catch (error) {
   if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') throw new ConflictError('Population record changed during review');
   throw error;
  }
 },
 async softDelete(id, actorId, client) {
  try {
   return await client.populationRecord.update({where: {id, deletedAt: null}, data: {deletedAt: new Date(), isPreferred: false, updatedById: actorId}, select: {...deleteSelect, deletedAt: true}});
  } catch (error) {
   if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') throw new NotFoundError('Population record not found');
   throw error;
  }
 },
 async update(id, input, actorId, client, needsReview) {
  const {expectedVersion, referenceDate, population, referenceYear, sourceId, isEstimate, notes} = input;
  try {
   return await client.populationRecord.update({where: {id, deletedAt: null, version: expectedVersion}, data: {population, referenceYear, sourceId, isEstimate, notes, ...(needsReview !== undefined ? {needsReview} : {}), ...(referenceDate !== undefined ? {referenceDate: referenceDate === null ? null : new Date(referenceDate)} : {}), updatedById: actorId, version: {increment: 1}}, select});
  } catch (error) {
   if (isPopulationBusinessKeyConflict(error) || isPreferredIndexConflict(error)) throw new ConflictError('Population record conflicts with an existing record');
   if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') throw new ConflictError('Population record changed during update');
   throw error;
  }
 },
 findLatestVerified(villageId, client, excludeId) {
  return client.populationRecord.findFirst({where: {villageId, verificationStatus: 'VERIFIED', deletedAt: null, ...(excludeId !== undefined ? {id: {not: excludeId}} : {})}, orderBy: [{referenceYear: 'desc'}, {id: 'asc'}], select: {population: true}});
 },
 async create(villageId, input, needsReview, context, client) {
  try {
   return await client.populationRecord.create({ data: {
    villageId, population: input.population, referenceYear: input.referenceYear, sourceId: input.sourceId,
    referenceDate: input.referenceDate ? new Date(input.referenceDate) : null,
    isEstimate: input.isEstimate, needsReview, isPreferred: false, notes: input.notes,
    verificationStatus: 'PENDING', version: 1, createdById: context.actorId, updatedById: context.actorId,
   }, select });
  } catch (error) {
   if (isPopulationBusinessKeyConflict(error)) throw new ConflictError('Population record conflicts with an existing record');
   throw error;
  }
 },
 async findMany({ villageId, filters, sort, skip, take }) {
  // A deleted source does not hide its population records.
  const where: Prisma.PopulationRecordWhereInput = { ...active, villageId, ...filters };
  return prisma.$transaction(async tx => {
   const [total, items] = await Promise.all([tx.populationRecord.count({where}), tx.populationRecord.findMany({where, select, skip, take, orderBy: [{[sort.field]: sort.order}, {id: 'asc'}]})]);
   return {items, total};
  }, { isolationLevel: 'RepeatableRead' });
 },
 findById(id) { return prisma.populationRecord.findFirst({where: {...active, id}, select}); },
};
