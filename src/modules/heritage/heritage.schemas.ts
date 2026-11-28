import { HeritageCategory, VerificationStatus } from '@prisma/client';
import { z } from 'zod';

export const HERITAGE_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;

const heritageFields = {
  name: z.string().trim().min(1).max(200),
  category: z.enum(HeritageCategory),
  description: z.string().trim().max(5000).nullable().optional(),
  sourceId: z.uuid().nullable().optional(),
};
export const createHeritageSchema = z.strictObject(heritageFields);
export const updateHeritageSchema = z.strictObject({
  ...heritageFields, name: heritageFields.name.optional(), category: heritageFields.category.optional(),
  version: z.number().int().positive().max(2147483646),
}).refine(value => Object.entries(value).some(([key, field]) => key !== 'version' && field !== undefined), {
  message: 'At least one editable field is required',
});
export type CreateHeritageInput = z.infer<typeof createHeritageSchema>;
export type UpdateHeritageInput = z.infer<typeof updateHeritageSchema>;

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
