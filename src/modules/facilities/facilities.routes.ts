import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './facilities.controller.js';
import { facilitiesParamsSchema, listFacilitiesQuerySchema, villageFacilitiesParamsSchema } from './facilities.schemas.js';

export const villageFacilitiesRouter = Router({ mergeParams: true });
export const facilitiesRouter = Router();

villageFacilitiesRouter.get(
  '/',
  validate({ params: villageFacilitiesParamsSchema, query: listFacilitiesQuerySchema }),
  controller.list,
);

facilitiesRouter.get('/:id', validate({ params: facilitiesParamsSchema }), controller.getById);
