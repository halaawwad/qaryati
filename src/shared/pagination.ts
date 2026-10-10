export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface Pagination {
  page: number;
  limit: number;
  /** Offset for the database query (Prisma `skip`). */
  skip: number;
  /** Page size for the database query (Prisma `take`). */
  take: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Parses `page`/`limit` from a query object, applying defaults and capping `limit` at MAX_LIMIT. */
export function parsePagination(query: { page?: unknown; limit?: unknown }): Pagination {
  const page = toPositiveInt(query.page, DEFAULT_PAGE);
  const limit = Math.min(toPositiveInt(query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function buildPaginationMeta(
  total: number,
  { page, limit }: Pick<Pagination, 'page' | 'limit'>,
): PaginationMeta {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}
