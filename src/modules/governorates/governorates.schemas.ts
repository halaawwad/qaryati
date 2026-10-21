import { LocalAuthorityType } from '@prisma/client';
import { z } from 'zod';

export const governorateParamsSchema = z.object({
  id: z.uuid(),
});

export const localAuthoritiesQuerySchema = z.object({
  type: z.enum(LocalAuthorityType).optional(),
});

export type GovernorateParams = z.infer<typeof governorateParamsSchema>;
export type LocalAuthoritiesQuery = z.infer<typeof localAuthoritiesQuerySchema>;
