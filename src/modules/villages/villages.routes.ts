import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { requireRole } from '../../shared/middlewares/requireRole.js';
import * as controller from './villages.controller.js';
import {
  listVillagesQuerySchema,
  nearbyVillagesQuerySchema,
  villageDetailsParamsSchema,
  villageGeoParamsSchema,
  applyGeoEnrichmentSchema,
} from './villages.schemas.js';

export const villagesRouter = Router();

villagesRouter.get('/:id/geo-candidates', authenticate, requireRole('ADMIN', 'REVIEWER'),
  validate({ params: villageGeoParamsSchema }), controller.geoCandidates);
villagesRouter.post('/:id/geo-enrichment', authenticate, requireRole('ADMIN', 'REVIEWER'),
  validate({ params: villageGeoParamsSchema, body: applyGeoEnrichmentSchema }), controller.applyGeoEnrichment);

villagesRouter.get('/', validate({ query: listVillagesQuerySchema }), controller.list);
villagesRouter.get('/:idOrSlug', validate({ params: villageDetailsParamsSchema }), controller.getByIdOrSlug);
villagesRouter.get(
  '/:idOrSlug/nearby',
  validate({ params: villageDetailsParamsSchema, query: nearbyVillagesQuerySchema }),
  controller.listNearby,
);
