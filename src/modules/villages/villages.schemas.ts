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

// --- Writes ---

export const villageIdParamsSchema = z.object({
  id: z.uuid(),
});

// Slugs are used in URLs (/villages/beita), so they are limited to lowercase ASCII letters, digits
// and single hyphens: readable, stable, and never in need of percent-encoding.
const slugSchema = z
  .string()
  .trim()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug may only contain lowercase English letters, digits and hyphens');

const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

const villageWriteFields = {
  slug: slugSchema,
  pcbsCode: optionalText(20),
  nameAr: z.string().trim().min(1).max(200),
  nameEn: optionalText(200),
  governorateId: z.uuid(),
  localAuthorityId: z.uuid().nullable().optional(),
  nameOrigin: optionalText(5000),
  nameOriginSourceId: z.uuid().nullable().optional(),
  // Valid WGS84 ranges; values outside them are typos, not places.
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  elevationM: z.number().int().nullable().optional(),
  areaDunums: z.number().positive().nullable().optional(),
  locationDescription: optionalText(10000),
  historicalOverview: optionalText(10000),
};

// A point needs both halves: half a coordinate cannot be placed on a map or used for distances.
// Requiring them in the same request also stops a PATCH from pairing a new latitude with a stale longitude.
function coordinatesTogether(data: { latitude?: number | null; longitude?: number | null }): boolean {
  return (data.latitude === undefined) === (data.longitude === undefined) && (data.latitude === null) === (data.longitude === null);
}

const coordinatesMessage = {
  message: 'latitude and longitude must be sent together, both as numbers or both as null',
  path: ['latitude'],
};

// strictObject rejects unknown keys with 400. That keeps server-owned fields out of the body:
// id, verificationStatus (only verify/reject change it), createdById, updatedById, deletedAt,
// and geoDisplayName / geoEnrichedAt (written by the geo enrichment job, owned by Zeina).
// version is accepted only on updates, and only to compare against the stored row.
export const createVillageBodySchema = z
  .strictObject(villageWriteFields)
  .refine(coordinatesTogether, coordinatesMessage);

export const updateVillageBodySchema = z
  .strictObject({
    version: z.number().int().positive(),
    ...villageWriteFields,
    slug: villageWriteFields.slug.optional(),
    nameAr: villageWriteFields.nameAr.optional(),
    governorateId: villageWriteFields.governorateId.optional(),
  })
  .refine(coordinatesTogether, coordinatesMessage)
  .refine((data) => Object.keys(data).some((key) => key !== 'version'), {
    message: 'At least one field to change is required besides version',
  });

export const villageVersionBodySchema = z.strictObject({
  version: z.number().int().positive(),
});

export type ListVillagesQuery = z.infer<typeof listVillagesQuerySchema>;
export type VillageDetailsParams = z.infer<typeof villageDetailsParamsSchema>;
export type NearbyVillagesQuery = z.infer<typeof nearbyVillagesQuerySchema>;
export type VillageIdParams = z.infer<typeof villageIdParamsSchema>;
export type CreateVillageInput = z.infer<typeof createVillageBodySchema>;
export type UpdateVillageInput = z.infer<typeof updateVillageBodySchema>;
export type VillageVersionInput = z.infer<typeof villageVersionBodySchema>;
export type VillageSortField = (typeof VILLAGE_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
