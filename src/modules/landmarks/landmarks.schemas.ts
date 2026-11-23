import { LandmarkType, VerificationStatus } from '@prisma/client';
import { z } from 'zod';

export const LANDMARK_SORT_FIELDS = ['nameAr', 'nameEn', 'createdAt'] as const;

export const villageLandmarksParamsSchema = z.object({
  villageId: z.uuid(),
});

export const landmarkParamsSchema = z.object({
  id: z.uuid(),
});

export const listLandmarksQuerySchema = z.object({
  // Values above MAX_LIMIT are accepted and capped by parsePagination.
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .transform((value) => value || undefined)
    .optional(),
  landmarkType: z.enum(LandmarkType).optional(),
  verificationStatus: z.enum(VerificationStatus).optional(),
  sort: z.enum(LANDMARK_SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const createLandmarkSchema = z.strictObject({
  nameAr: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().min(1).max(200).optional(),
  landmarkType: z.enum(LandmarkType),
  description: z.string().trim().max(5000).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  sourceId: z.uuid(),
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

export type CreateLandmarkInput = z.infer<typeof createLandmarkSchema>;
export type VillageLandmarksParams = z.infer<typeof villageLandmarksParamsSchema>;
export type LandmarkParams = z.infer<typeof landmarkParamsSchema>;
export type ListLandmarksQuery = z.infer<typeof listLandmarksQuerySchema>;
export type LandmarkSortField = (typeof LANDMARK_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
