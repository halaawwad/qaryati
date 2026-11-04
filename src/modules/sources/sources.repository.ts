import type { Prisma, Role, Source, SourceType, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import { AuditAction } from '@prisma/client';
import { recordAudit } from '../audit/audit.service.js';
import type { CreateSourceInput, UpdateSourceInput } from './sources.schemas.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors.js';

export interface SourceCreateContext {
  actorId: string;
  requestId: string;
}

export interface SourceUpdateContext extends SourceCreateContext {
  role: Role;
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
  update(id: string, input: UpdateSourceInput, context: SourceUpdateContext): Promise<SourceDetails>;
  create(input: CreateSourceInput, context: SourceCreateContext): Promise<SourceDetails>;
  findMany(params: SourceListParams): Promise<{ items: SourceDetails[]; total: number }>;
  findById(id: string): Promise<SourceDetails | null>;
}

const sourceSelect = {
  id: true, title: true, author: true, publisher: true, year: true, url: true,
  sourceType: true, citationText: true, verificationStatus: true, version: true,
  createdAt: true, updatedAt: true,
} satisfies Prisma.SourceSelect;

function auditUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    // Omit all query parameters and fragments, including unrecognized secret names.
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // Legacy malformed URLs must never be copied verbatim into Audit.
    return null;
  }
}

function updateSnapshot(source: SourceDetails): Prisma.InputJsonObject {
  return {
    id: source.id, title: source.title, sourceType: source.sourceType,
    author: source.author, publisher: source.publisher, year: source.year,
    url: auditUrl(source.url), citationText: source.citationText,
    verificationStatus: source.verificationStatus, version: source.version,
  };
}

export const sourceRepository: SourceRepository = {
  async update(id, input, context) {
    return prisma.$transaction(async (tx) => {
      const current = await tx.source.findFirst({
        where: { id, deletedAt: null }, select: { ...sourceSelect, createdById: true },
      });
      if (!current) throw new NotFoundError('Source not found');

      const editor = context.role === 'EDITOR';
      // REJECTED is temporarily fail-closed until the team defines its editing policy.
      const allowed = editor
        ? current.verificationStatus === 'PENDING' && current.createdById === context.actorId
        : (context.role === 'REVIEWER' || context.role === 'ADMIN')
          && (current.verificationStatus === 'PENDING' || current.verificationStatus === 'VERIFIED');
      if (!allowed) throw new ForbiddenError('Direct editing is not permitted for this source');
      if (current.version !== input.expectedVersion) throw new ConflictError('Source version conflict');

      const changes = {
        title: input.title, sourceType: input.sourceType, author: input.author,
        publisher: input.publisher, year: input.year, url: input.url, citationText: input.citationText,
      };
      const changed = Object.entries(changes).some(([key, value]) =>
        value !== undefined && value !== current[key as keyof typeof changes]);
      // Do not expose the creator ID selected solely for authorization.
      const { createdById: _createdById, ...before } = current;
      if (!changed) return before;

      let updated: SourceDetails;
      try {
        updated = await tx.source.update({
          where: {
            id, deletedAt: null, version: input.expectedVersion,
            verificationStatus: current.verificationStatus,
            ...(editor ? { createdById: context.actorId } : {}),
          },
          data: { ...changes, updatedById: context.actorId, version: { increment: 1 } },
          select: sourceSelect,
        });
      } catch (err) {
        // A failed conditional update means the record changed after our read.
        if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2025') {
          throw new ConflictError('Source changed during update');
        }
        throw err;
      }
      await recordAudit({
        entityType: 'Source', entityId: id, action: AuditAction.UPDATE,
        actorId: context.actorId, requestId: context.requestId,
        before: updateSnapshot(before), after: updateSnapshot(updated),
      }, tx);
      return updated;
    });
  },
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
