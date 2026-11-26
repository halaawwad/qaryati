import { z } from 'zod';
import { updatePopulationSchema } from '../population/population.schemas.js';

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
