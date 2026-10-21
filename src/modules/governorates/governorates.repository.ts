import type { Governorate, LocalAuthority, LocalAuthorityType, Prisma } from '@prisma/client';
import { prisma } from '../../shared/db.js';

export type GovernorateSummary = Pick<Governorate, 'id' | 'nameAr' | 'nameEn' | 'code'> & {
  villagesCount: number;
};
export type GovernorateDetails = GovernorateSummary & { localAuthoritiesCount: number };
export type LocalAuthoritySummary = Pick<
  LocalAuthority,
  'id' | 'governorateId' | 'nameAr' | 'nameEn' | 'type' | 'sourceId' | 'asOfYear'
>;

export interface LocalAuthorityFilter {
  type?: LocalAuthorityType;
}

export interface GovernorateRepository {
  findAll(): Promise<GovernorateSummary[]>;
  findById(id: string): Promise<GovernorateDetails | null>;
  /** Returns null when the governorate does not exist, and [] when it has no matching local authorities. */
  findLocalAuthorities(governorateId: string, filter: LocalAuthorityFilter): Promise<LocalAuthoritySummary[] | null>;
}

function governorateSelect() {
  return {
    id: true,
    nameAr: true,
    nameEn: true,
    code: true,
  } satisfies Prisma.GovernorateSelect;
}

function localAuthoritySelect() {
  return {
    id: true,
    governorateId: true,
    nameAr: true,
    nameEn: true,
    type: true,
    sourceId: true,
    asOfYear: true,
  } satisfies Prisma.LocalAuthoritySelect;
}

// Soft-deleted villages never count towards a governorate.
const activeVillages = { where: { deletedAt: null } } satisfies Prisma.Governorate$villagesArgs;

export const governorateRepository: GovernorateRepository = {
  async findAll() {
    const rows = await prisma.governorate.findMany({
      select: {
        ...governorateSelect(),
        _count: { select: { villages: activeVillages } },
      },
      orderBy: { nameEn: 'asc' },
    });

    return rows.map(({ _count, ...governorate }) => ({
      ...governorate,
      villagesCount: _count.villages,
    }));
  },

  async findById(id) {
    const row = await prisma.governorate.findUnique({
      where: { id },
      select: {
        ...governorateSelect(),
        _count: { select: { villages: activeVillages, localAuthorities: true } },
      },
    });

    if (!row) return null;

    const { _count, ...governorate } = row;
    return {
      ...governorate,
      villagesCount: _count.villages,
      localAuthoritiesCount: _count.localAuthorities,
    };
  },

  async findLocalAuthorities(governorateId, filter) {
    const row = await prisma.governorate.findUnique({
      where: { id: governorateId },
      select: {
        localAuthorities: {
          where: { type: filter.type },
          orderBy: { nameAr: 'asc' },
          select: localAuthoritySelect(),
        },
      },
    });

    return row?.localAuthorities ?? null;
  },
};
