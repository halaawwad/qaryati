import { HeritageCategory, VerificationStatus } from '@prisma/client';
import { z } from 'zod';

export const HERITAGE_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;

export const villageHeritageParamsSchema = z.object({ villageId: z.uuid() });
export const heritageParamsSchema = z.object({ id: z.uuid() });

export const listHeritageQuerySchema = z.object({
  // Shared pagination supplies defaults and caps the limit at 100.
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(100).transform((value) => value || undefined).optional(),
  category: z.enum(HeritageCategory).optional(),
  verificationStatus: z.enum(VerificationStatus).optional(),
  sort: z.enum(HERITAGE_SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export type VillageHeritageParams = z.infer<typeof villageHeritageParamsSchema>;
export type HeritageParams = z.infer<typeof heritageParamsSchema>;
export type ListHeritageQuery = z.infer<typeof listHeritageQuerySchema>;
export type HeritageSortField = (typeof HERITAGE_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
