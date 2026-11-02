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
