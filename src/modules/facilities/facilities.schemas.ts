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

export const createFacilitySchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  facilityType: z.enum(FacilityType),
  sourceId: z.uuid(),
  description: z.string().trim().max(5000).optional(),
  asOfYear: z.number().int().min(-2147483648).max(2147483647).nullable().optional(),
  // PostgreSQL Decimal(9,6) determines stored precision; do not round request values.
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
}).superRefine(({ latitude, longitude }, ctx) => {
  const hasLatitude = latitude !== undefined && latitude !== null;
  const hasLongitude = longitude !== undefined && longitude !== null;
  if (hasLatitude !== hasLongitude) {
    ctx.addIssue({
      code: 'custom',
      path: [hasLatitude ? 'longitude' : 'latitude'],
      message: 'Latitude and longitude must both be numbers or both be omitted/null',
    });
  }
});

export type CreateFacilityInput = z.infer<typeof createFacilitySchema>;
export type VillageFacilitiesParams = z.infer<typeof villageFacilitiesParamsSchema>;
export type FacilitiesParams = z.infer<typeof facilitiesParamsSchema>;
export type ListFacilitiesQuery = z.infer<typeof listFacilitiesQuerySchema>;
export type FacilitySortField = (typeof FACILITY_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
