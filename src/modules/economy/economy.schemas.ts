import { EconomicCategory, VerificationStatus } from '@prisma/client';
import { z } from 'zod';
import { parsePagination } from '../../shared/pagination.js';

export const ECONOMY_SORT_FIELDS = ['name', 'asOfYear', 'createdAt', 'updatedAt'] as const;

// Match Events' integer-year parsing without inventing a historical/future-year policy.
const yearQuerySchema = z.union([z.string().trim().min(1), z.number()])
  .transform(value => Number(value))
  .pipe(z.number().int().min(-2147483648).max(2147483647));

const MAX_ECONOMY_OFFSET = 2_147_483_647;

export const villageEconomyParamsSchema = z.object({ villageId: z.uuid() });
export const economyParamsSchema = z.object({ id: z.uuid() });

export const listEconomyQuerySchema = z.object({
  // Shared pagination supplies defaults and caps the limit at 100.
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(100).transform((value) => value || undefined).optional(),
  category: z.enum(EconomicCategory).optional(),
  verificationStatus: z.enum(VerificationStatus).optional(),
  isMajor: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
  asOfYear: yearQuerySchema.optional(),
  sort: z.enum(ECONOMY_SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
}).refine(
  query => {
    const { skip } = parsePagination(query);
    return Number.isSafeInteger(skip) && skip <= MAX_ECONOMY_OFFSET;
  },
  { path: ['page'], message: `Pagination offset must not exceed ${MAX_ECONOMY_OFFSET}` },
);

export type VillageEconomyParams = z.infer<typeof villageEconomyParamsSchema>;
export type EconomyParams = z.infer<typeof economyParamsSchema>;
export type ListEconomyQuery = z.infer<typeof listEconomyQuerySchema>;
export type EconomySortField = (typeof ECONOMY_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
