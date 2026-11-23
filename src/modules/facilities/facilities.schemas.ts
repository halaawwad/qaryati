import { FacilityType, VerificationStatus } from '@prisma/client';
import { z } from 'zod';
import { parsePagination } from '../../shared/pagination.js';

export const FACILITY_SORT_FIELDS = ['name', 'asOfYear', 'createdAt', 'updatedAt'] as const;
const MAX_FACILITY_OFFSET = 2_147_483_647;

export const villageFacilitiesParamsSchema = z.object({ villageId: z.uuid() });
export const facilitiesParamsSchema = z.object({ id: z.uuid() });

// Match Events: reject blank years, preserve zero, and stay within PostgreSQL Int.
const yearQuerySchema = z.union([z.string().trim().min(1), z.number()])
  .transform(value => Number(value))
  .pipe(z.number().int().min(-2147483648).max(2147483647));

export const listFacilitiesQuerySchema = z.object({
  // Shared pagination applies defaults and caps limits above 100.
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(100).transform(value => value || undefined).optional(),
  facilityType: z.enum(FacilityType).optional(),
  verificationStatus: z.enum(VerificationStatus).optional(),
  asOfYear: yearQuerySchema.optional(),
  sort: z.enum(FACILITY_SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
}).refine(
  query => {
    const { skip } = parsePagination(query);
    return Number.isSafeInteger(skip) && skip <= MAX_FACILITY_OFFSET;
  },
  { path: ['page'], message: `Pagination offset must not exceed ${MAX_FACILITY_OFFSET}` },
);

export type VillageFacilitiesParams = z.infer<typeof villageFacilitiesParamsSchema>;
export type FacilitiesParams = z.infer<typeof facilitiesParamsSchema>;
export type ListFacilitiesQuery = z.infer<typeof listFacilitiesQuerySchema>;
export type FacilitySortField = (typeof FACILITY_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
