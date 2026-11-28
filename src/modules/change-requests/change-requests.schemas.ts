import { z } from 'zod';
import { populationProposalSchema, updatePopulationSchema } from '../population/population.schemas.js';
import { ChangeRequestStatus } from '@prisma/client';
import { parsePagination } from '../../shared/pagination.js';

export const submitChangeRequestSchema = z.strictObject({
 entityType: z.literal('PopulationRecord'),
 entityId: z.uuid(),
 baseVersion: updatePopulationSchema.shape.expectedVersion,
 proposedChanges: populationProposalSchema,
 reason: z.string().trim().max(5000).optional(),
});
export type SubmitChangeRequestInput = z.infer<typeof submitChangeRequestSchema>;
const positiveQueryInteger = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().safe());
export const listChangeRequestsSchema = z.object({
 page: positiveQueryInteger.optional(), limit: positiveQueryInteger.optional(),
 status: z.enum(ChangeRequestStatus).optional(), entityType: z.literal('PopulationRecord').optional(),
 entityId: z.uuid().optional(), requestedById: z.uuid().optional(),
}).refine(query => { const {skip}=parsePagination(query); return Number.isSafeInteger(skip) && skip<=2147483647; }, {path:['page'],message:'Pagination offset must not exceed 2147483647'});
export const changeRequestParamsSchema = z.object({id:z.uuid()});
export const withdrawChangeRequestSchema = z.strictObject({});
export const rejectChangeRequestSchema = z.strictObject({reviewComment:z.string().trim().min(1).max(5000)});
export type RejectChangeRequestInput = z.infer<typeof rejectChangeRequestSchema>;
export const approveChangeRequestSchema = z.strictObject({reviewComment:z.string().trim().min(1).max(5000).optional()});
export type ApproveChangeRequestInput = z.infer<typeof approveChangeRequestSchema>;
export type ListChangeRequestsQuery = z.infer<typeof listChangeRequestsSchema>;
