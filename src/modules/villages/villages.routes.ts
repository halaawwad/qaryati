import { Role } from '@prisma/client';
import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { requireRole } from '../../shared/middlewares/requireRole.js';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './villages.controller.js';
import {
  createVillageBodySchema,
  listVillagesQuerySchema,
  nearbyVillagesQuerySchema,
  updateVillageBodySchema,
  villageDetailsParamsSchema,
  villageIdParamsSchema,
  villageVersionBodySchema,
} from './villages.schemas.js';

const EDITORS = [Role.EDITOR, Role.REVIEWER, Role.ADMIN];
const REVIEWERS = [Role.REVIEWER, Role.ADMIN];

export const villagesRouter = Router();

villagesRouter.get('/', validate({ query: listVillagesQuerySchema }), controller.list);
villagesRouter.get('/:idOrSlug', validate({ params: villageDetailsParamsSchema }), controller.getByIdOrSlug);
villagesRouter.get(
  '/:idOrSlug/nearby',
  validate({ params: villageDetailsParamsSchema, query: nearbyVillagesQuerySchema }),
  controller.listNearby,
);

villagesRouter.post(
  '/',
  authenticate,
  requireRole(...EDITORS),
  validate({ body: createVillageBodySchema }),
  controller.create,
);
villagesRouter.patch(
  '/:id',
  authenticate,
  requireRole(...EDITORS),
  validate({ params: villageIdParamsSchema, body: updateVillageBodySchema }),
  controller.update,
);
villagesRouter.delete(
  '/:id',
  authenticate,
  requireRole(Role.ADMIN),
  validate({ params: villageIdParamsSchema }),
  controller.remove,
);
villagesRouter.post(
  '/:id/verify',
  authenticate,
  requireRole(...REVIEWERS),
  validate({ params: villageIdParamsSchema, body: villageVersionBodySchema }),
  controller.verify,
);
villagesRouter.post(
  '/:id/reject',
  authenticate,
  requireRole(...REVIEWERS),
  validate({ params: villageIdParamsSchema, body: villageVersionBodySchema }),
  controller.reject,
);
