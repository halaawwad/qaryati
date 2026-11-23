import { VerificationStatus } from '@prisma/client';
import { z } from 'zod';

export const VILLAGE_SORT_FIELDS = ['nameAr', 'nameEn', 'createdAt', 'elevationM', 'areaDunums'] as const;

export const listVillagesQuerySchema = z.object({
  // Values above MAX_LIMIT are accepted and capped by parsePagination.
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .transform((value) => value || undefined)
    .optional(),
  governorateId: z.uuid().optional(),
  localAuthorityId: z.uuid().optional(),
  verificationStatus: z.enum(VerificationStatus).optional(),
  sort: z.enum(VILLAGE_SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

// Format is not restricted: an unknown slug is a 404, not a validation error.
export const villageDetailsParamsSchema = z.object({
  idOrSlug: z.string().trim().min(1).max(200),
});

export const MAX_NEARBY_RADIUS_KM = 50;

export const nearbyVillagesQuerySchema = z.object({
  radiusKm: z.coerce.number().positive().max(MAX_NEARBY_RADIUS_KM).optional(),
});

export type ListVillagesQuery = z.infer<typeof listVillagesQuerySchema>;
export type VillageDetailsParams = z.infer<typeof villageDetailsParamsSchema>;
export type NearbyVillagesQuery = z.infer<typeof nearbyVillagesQuerySchema>;
export type VillageSortField = (typeof VILLAGE_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
