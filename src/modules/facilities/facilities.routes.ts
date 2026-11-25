import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { requireRole } from '../../shared/middlewares/requireRole.js';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './facilities.controller.js';
import { createFacilitySchema, updateFacilitySchema, facilitiesParamsSchema, listFacilitiesQuerySchema, villageFacilitiesParamsSchema } from './facilities.schemas.js';

export const villageFacilitiesRouter = Router({ mergeParams: true });
export const facilitiesRouter = Router();

villageFacilitiesRouter.post(
  '/',
  authenticate,
  requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ params: villageFacilitiesParamsSchema, body: createFacilitySchema }),
  controller.create,
);

villageFacilitiesRouter.get(
  '/',
  validate({ params: villageFacilitiesParamsSchema, query: listFacilitiesQuerySchema }),
  controller.list,
);

facilitiesRouter.get('/:id', validate({ params: facilitiesParamsSchema }), controller.getById);
facilitiesRouter.patch('/:id', authenticate, requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ params: facilitiesParamsSchema, body: updateFacilitySchema }), controller.update);
facilitiesRouter.delete('/:id', authenticate, requireRole('ADMIN'),
  validate({ params: facilitiesParamsSchema }), controller.remove);
