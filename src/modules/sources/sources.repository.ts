import type { Prisma, Source, SourceType, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';

export type SourceDetails = Pick<Source,
  'id' | 'title' | 'author' | 'publisher' | 'year' | 'url' | 'sourceType' |
  'citationText' | 'verificationStatus' | 'version' | 'createdAt' | 'updatedAt'
>;

export interface SourceListParams {
  filters: { sourceType?: SourceType; verificationStatus?: VerificationStatus };
  skip: number;
  take: number;
}

export interface SourceRepository {
  findMany(params: SourceListParams): Promise<{ items: SourceDetails[]; total: number }>;
  findById(id: string): Promise<SourceDetails | null>;
}

const sourceSelect = {
  id: true, title: true, author: true, publisher: true, year: true, url: true,
  sourceType: true, citationText: true, verificationStatus: true, version: true,
  createdAt: true, updatedAt: true,
} satisfies Prisma.SourceSelect;

export const sourceRepository: SourceRepository = {
  async findMany(params) {
    const where = {
      deletedAt: null,
      sourceType: params.filters.sourceType,
      verificationStatus: params.filters.verificationStatus,
    } satisfies Prisma.SourceWhereInput;

    return prisma.$transaction(async (tx) => {
      const [total, items] = await Promise.all([
        tx.source.count({ where }),
        tx.source.findMany({
          where,
          orderBy: [{ title: 'asc' }, { id: 'asc' }],
          skip: params.skip,
          take: params.take,
          select: sourceSelect,
        }),
      ]);
      return { items, total };
    });
  },

  findById(id) {
    return prisma.source.findFirst({
      where: { id, deletedAt: null },
      select: sourceSelect,
    });
  },
};
