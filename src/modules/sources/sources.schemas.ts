import { SourceType, VerificationStatus } from '@prisma/client';
import { z } from 'zod';
import { parsePagination } from '../../shared/pagination.js';

// Keep Sources offsets within a conservative signed 32-bit range supported by
// Prisma, well below JavaScript's maximum safe integer.
const MAX_SOURCE_OFFSET = 2_147_483_647;

export const sourceParamsSchema = z.object({ id: z.uuid() });

export const listSourcesQuerySchema = z.object({
  // The shared pagination utility caps limits above 100.
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  sourceType: z.enum(SourceType).optional(),
  verificationStatus: z.enum(VerificationStatus).optional(),
}).refine(
  (query) => {
    const { skip } = parsePagination(query);
    return Number.isSafeInteger(skip) && skip <= MAX_SOURCE_OFFSET;
  },
  { path: ['page'], message: `Pagination offset must not exceed ${MAX_SOURCE_OFFSET}` },
);

export type SourceParams = z.infer<typeof sourceParamsSchema>;
export type ListSourcesQuery = z.infer<typeof listSourcesQuerySchema>;

export const createSourceSchema = z.strictObject({
  title: z.string().trim().min(1),
  sourceType: z.enum(SourceType),
  author: z.string().optional(),
  publisher: z.string().optional(),
  // API policy for publication years (CE), including forthcoming publications.
  // This is input validation, not a database constraint.
  year: z.number().int().min(1).max(new Date().getUTCFullYear() + 1).optional(),
  url: z.url({ protocol: /^https?$/ }).refine((value) => {
    try {
      const url = new URL(value);
      return url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, { message: 'URL must not contain username or password credentials' }).optional(),
  citationText: z.string().optional(),
});

export type CreateSourceInput = z.infer<typeof createSourceSchema>;

export const updateSourceSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  title: createSourceSchema.shape.title.optional(),
  sourceType: createSourceSchema.shape.sourceType.optional(),
  author: createSourceSchema.shape.author.nullable(),
  publisher: createSourceSchema.shape.publisher.nullable(),
  year: createSourceSchema.shape.year.nullable(),
  url: createSourceSchema.shape.url.nullable(),
  citationText: createSourceSchema.shape.citationText.nullable(),
}).refine(
  ({ expectedVersion: _expectedVersion, ...changes }) => Object.values(changes).some(value => value !== undefined),
  { message: 'At least one editable field is required' },
);

export type UpdateSourceInput = z.infer<typeof updateSourceSchema>;
