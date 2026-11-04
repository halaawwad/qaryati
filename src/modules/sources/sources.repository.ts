import type { Prisma, Source, SourceType, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import { AuditAction } from '@prisma/client';
import { recordAudit } from '../audit/audit.service.js';
import type { CreateSourceInput } from './sources.schemas.js';

export interface SourceCreateContext {
  actorId: string;
  requestId: string;
}

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
  create(input: CreateSourceInput, context: SourceCreateContext): Promise<SourceDetails>;
  findMany(params: SourceListParams): Promise<{ items: SourceDetails[]; total: number }>;
  findById(id: string): Promise<SourceDetails | null>;
}

const sourceSelect = {
  id: true, title: true, author: true, publisher: true, year: true, url: true,
  sourceType: true, citationText: true, verificationStatus: true, version: true,
  createdAt: true, updatedAt: true,
} satisfies Prisma.SourceSelect;

export const sourceRepository: SourceRepository = {
  async create(input, context) {
    return prisma.$transaction(async (tx) => {
      const source = await tx.source.create({
        data: {
          title: input.title, sourceType: input.sourceType,
          author: input.author, publisher: input.publisher, year: input.year,
          url: input.url, citationText: input.citationText,
          createdById: context.actorId, updatedById: context.actorId,
          // Prisma supplies PENDING and version 1, along with ID and timestamps.
        },
        select: sourceSelect,
      });
      await recordAudit({
        entityType: 'Source', entityId: source.id, action: AuditAction.CREATE,
        actorId: context.actorId, requestId: context.requestId,
        after: {
          id: source.id, title: source.title, sourceType: source.sourceType,
          author: source.author, publisher: source.publisher, year: source.year,
          url: source.url, citationText: source.citationText,
          verificationStatus: source.verificationStatus, version: source.version,
        },
      }, tx);
      return source;
    });
  },
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
