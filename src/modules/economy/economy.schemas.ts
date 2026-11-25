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

export const createEconomySchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  category: z.enum(EconomicCategory),
  sourceId: z.uuid(),
  description: z.string().trim().max(5000).optional(),
  isMajor: z.boolean().default(false),
  asOfYear: z.number().int().min(-2147483648).max(2147483647).nullable().optional(),
});

export type CreateEconomyInput = z.infer<typeof createEconomySchema>;
export const updateEconomySchema = z.strictObject({
  version: z.number().int().positive().max(2147483646),
  name: createEconomySchema.shape.name.optional(),
  category: createEconomySchema.shape.category.optional(),
  sourceId: createEconomySchema.shape.sourceId.optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  isMajor: z.boolean().optional(),
  asOfYear: createEconomySchema.shape.asOfYear,
}).refine(value => Object.entries(value).some(([key, field]) => key !== 'version' && field !== undefined), {
  message: 'At least one editable field is required',
});
export type UpdateEconomyInput = z.infer<typeof updateEconomySchema>;
export type VillageEconomyParams = z.infer<typeof villageEconomyParamsSchema>;
export type EconomyParams = z.infer<typeof economyParamsSchema>;
export type ListEconomyQuery = z.infer<typeof listEconomyQuerySchema>;
export type EconomySortField = (typeof ECONOMY_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
