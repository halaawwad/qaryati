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

export type VillageLandmarksParams = z.infer<typeof villageLandmarksParamsSchema>;
export type LandmarkParams = z.infer<typeof landmarkParamsSchema>;
export type ListLandmarksQuery = z.infer<typeof listLandmarksQuerySchema>;
export type LandmarkSortField = (typeof LANDMARK_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
