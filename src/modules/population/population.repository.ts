import { Prisma, type PopulationRecord, type VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import { ConflictError } from '../../shared/errors.js';
import type { CreatePopulationInput } from './population.schemas.js';
export interface PopulationCreateContext { actorId: string; requestId: string }
export type PopulationDetails = Pick<PopulationRecord, 'id' | 'villageId' | 'population' | 'referenceYear' | 'referenceDate' | 'sourceId' | 'isEstimate' | 'isPreferred' | 'needsReview' | 'notes' | 'verificationStatus' | 'version' | 'createdAt' | 'updatedAt'>;
export interface PopulationListParams {
 villageId: string; filters: { referenceYear?: number; sourceId?: string; isEstimate?: boolean; isPreferred?: boolean; needsReview?: boolean; verificationStatus?: VerificationStatus };
 sort: { field: 'referenceYear' | 'population' | 'createdAt' | 'updatedAt'; order: 'asc' | 'desc' }; skip: number; take: number;
}
export interface PopulationRepository { transaction<T>(fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T>; findLatestVerified(villageId: string, client: Prisma.TransactionClient): Promise<{population: number} | null>; create(villageId: string, input: CreatePopulationInput, needsReview: boolean, context: PopulationCreateContext, client: Prisma.TransactionClient): Promise<PopulationDetails>; findMany(params: PopulationListParams): Promise<{ items: PopulationDetails[]; total: number }>; findById(id: string): Promise<PopulationDetails | null> }
const select = { id: true, villageId: true, population: true, referenceYear: true, referenceDate: true, sourceId: true, isEstimate: true, isPreferred: true, needsReview: true, notes: true, verificationStatus: true, version: true, createdAt: true, updatedAt: true } satisfies Prisma.PopulationRecordSelect;
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
export const populationRepository: PopulationRepository = {
 transaction(fn) { return prisma.$transaction(fn); },
 findLatestVerified(villageId, client) {
  return client.populationRecord.findFirst({where: {villageId, verificationStatus: 'VERIFIED', deletedAt: null}, orderBy: [{referenceYear: 'desc'}, {id: 'asc'}], select: {population: true}});
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
