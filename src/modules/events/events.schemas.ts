import { VerificationStatus } from '@prisma/client';
import { z } from 'zod';

export const EVENT_SORT_FIELDS = ['eventYear', 'eventDate', 'title', 'createdAt'] as const;

export const villageEventsParamsSchema = z.object({
  villageId: z.uuid(),
});

export const eventParamsSchema = z.object({
  id: z.uuid(),
});

// Reject empty strings instead of coercing them to year zero.
const yearQuerySchema = z.union([z.string().trim().min(1), z.number()])
  .transform((value) => Number(value))
  .pipe(z.number().int().min(-2147483648).max(2147483647));

export const listEventsQuerySchema = z.object({
  // Values above MAX_LIMIT are accepted and capped by parsePagination.
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(100).transform((value) => value || undefined).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  verificationStatus: z.enum(VerificationStatus).optional(),
  isApproximate: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  yearFrom: yearQuerySchema.optional(),
  yearTo: yearQuerySchema.optional(),
  sort: z.enum(EVENT_SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
}).refine(
  ({ yearFrom, yearTo }) => yearFrom === undefined || yearTo === undefined || yearFrom <= yearTo,
  { path: ['yearTo'], message: 'yearTo must be greater than or equal to yearFrom' },
);

export type VillageEventsParams = z.infer<typeof villageEventsParamsSchema>;
export type EventParams = z.infer<typeof eventParamsSchema>;
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
export type EventSortField = (typeof EVENT_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
