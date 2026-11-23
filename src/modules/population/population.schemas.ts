import { VerificationStatus } from '@prisma/client';
import { z } from 'zod';
import { parsePagination } from '../../shared/pagination.js';
export const villagePopulationParamsSchema = z.object({ villageId: z.uuid() });
export const populationParamsSchema = z.object({ id: z.uuid() });
export const createPopulationSchema = z.strictObject({
 population: z.number().int().min(1).max(2147483647),
 referenceYear: z.number().int().min(1800).max(2100),
 sourceId: z.uuid(),
 referenceDate: z.iso.datetime({ offset: true }).nullable().optional(),
 isEstimate: z.boolean().default(false),
 needsReview: z.boolean().default(false),
 notes: z.string().trim().max(5000).nullable().optional(),
});
export type CreatePopulationInput = z.infer<typeof createPopulationSchema>;
export const updatePopulationSchema = z.strictObject({
 expectedVersion: z.number().int().positive().max(2147483647),
 population: createPopulationSchema.shape.population.optional(),
 referenceYear: createPopulationSchema.shape.referenceYear.optional(),
 referenceDate: createPopulationSchema.shape.referenceDate,
 sourceId: createPopulationSchema.shape.sourceId.optional(),
 isEstimate: z.boolean().optional(), needsReview: z.boolean().optional(),
 notes: createPopulationSchema.shape.notes,
}).refine(({expectedVersion: _version, ...changes}) => Object.values(changes).some(value => value !== undefined), {message: 'At least one editable field is required'});
export type UpdatePopulationInput = z.infer<typeof updatePopulationSchema>;
const bool = z.enum(['true', 'false']).transform(value => value === 'true');
const year = z.union([z.string().trim().min(1), z.number()]).transform(Number).pipe(z.number().int().min(-2147483648).max(2147483647));
export const listPopulationQuerySchema = z.object({
 page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().positive().optional(),
 referenceYear: year.optional(), sourceId: z.uuid().optional(), isEstimate: bool.optional(), isPreferred: bool.optional(), needsReview: bool.optional(),
 verificationStatus: z.enum(VerificationStatus).optional(), sort: z.enum(['referenceYear', 'population', 'createdAt', 'updatedAt']).optional(), order: z.enum(['asc', 'desc']).optional(),
}).refine(q => { const {skip} = parsePagination(q); return Number.isSafeInteger(skip) && skip <= 2147483647; }, {path: ['page'], message: 'Pagination offset must not exceed 2147483647'});
export type VillagePopulationParams = z.infer<typeof villagePopulationParamsSchema>;
export type PopulationParams = z.infer<typeof populationParamsSchema>;
export type ListPopulationQuery = z.infer<typeof listPopulationQuerySchema>;
