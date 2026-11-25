import { VerificationStatus } from '@prisma/client';
import { z } from 'zod';

export const EVENT_SORT_FIELDS = ['eventYear', 'eventDate', 'title', 'createdAt'] as const;

// Historical years are independent of the optional timestamp; BCE dates use eventYear.
const eventDateSchema = z.iso.datetime({ offset: true })
  .refine(value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999;
  }, 'eventDate must normalize to a year from 0001 through 9999')
  .transform(value => new Date(value));
const eventFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullable().optional(),
  eventYear: z.number().int().min(-2147483648).max(2147483647).nullable().optional(),
  eventDate: eventDateSchema.nullable().optional(),
  isApproximate: z.boolean(),
  category: z.string().trim().min(1).max(100).nullable().optional(),
  sourceId: z.uuid().nullable().optional(),
};
export const createEventSchema = z.strictObject({ ...eventFields, isApproximate: eventFields.isApproximate.default(false) });
export const updateEventSchema = z.strictObject({
  ...eventFields, title: eventFields.title.optional(), isApproximate: eventFields.isApproximate.optional(),
  version: z.number().int().positive().max(2147483646),
}).refine(value => Object.entries(value).some(([key, field]) => key !== 'version' && field !== undefined), {
  message: 'At least one editable field is required',
});
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

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
