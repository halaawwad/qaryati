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

export type ListVillagesQuery = z.infer<typeof listVillagesQuerySchema>;
export type VillageSortField = (typeof VILLAGE_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
