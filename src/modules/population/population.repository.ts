import type { PopulationRecord, Prisma, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
export type PopulationDetails = Pick<PopulationRecord, 'id' | 'villageId' | 'population' | 'referenceYear' | 'referenceDate' | 'sourceId' | 'isEstimate' | 'isPreferred' | 'needsReview' | 'notes' | 'verificationStatus' | 'version' | 'createdAt' | 'updatedAt'>;
export interface PopulationListParams {
 villageId: string; filters: { referenceYear?: number; sourceId?: string; isEstimate?: boolean; isPreferred?: boolean; needsReview?: boolean; verificationStatus?: VerificationStatus };
 sort: { field: 'referenceYear' | 'population' | 'createdAt' | 'updatedAt'; order: 'asc' | 'desc' }; skip: number; take: number;
}
export interface PopulationRepository { findMany(params: PopulationListParams): Promise<{ items: PopulationDetails[]; total: number }>; findById(id: string): Promise<PopulationDetails | null> }
const select = { id: true, villageId: true, population: true, referenceYear: true, referenceDate: true, sourceId: true, isEstimate: true, isPreferred: true, needsReview: true, notes: true, verificationStatus: true, version: true, createdAt: true, updatedAt: true } satisfies Prisma.PopulationRecordSelect;
const active = { deletedAt: null, village: { deletedAt: null } } satisfies Prisma.PopulationRecordWhereInput;
export const populationRepository: PopulationRepository = {
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
