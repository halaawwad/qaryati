import { z } from 'zod';
import { updatePopulationSchema } from '../population/population.schemas.js';
import { ChangeRequestStatus } from '@prisma/client';
import { parsePagination } from '../../shared/pagination.js';

const populationProposalSchema = z.strictObject({
 population: updatePopulationSchema.shape.population,
 referenceYear: updatePopulationSchema.shape.referenceYear,
 referenceDate: updatePopulationSchema.shape.referenceDate,
 sourceId: updatePopulationSchema.shape.sourceId.unwrap().transform(value => value.toLowerCase()).optional(),
 isEstimate: updatePopulationSchema.shape.isEstimate,
 notes: updatePopulationSchema.shape.notes,
}).refine(changes => Object.values(changes).some(value => value !== undefined), {message:'At least one editable field is required'});
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
export const rejectChangeRequestSchema = z.strictObject({reviewComment:z.string().trim().min(1).max(5000)});
export type RejectChangeRequestInput = z.infer<typeof rejectChangeRequestSchema>;
export type ListChangeRequestsQuery = z.infer<typeof listChangeRequestsSchema>;
