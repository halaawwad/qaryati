import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './villages.controller.js';
import { listVillagesQuerySchema, villageDetailsParamsSchema } from './villages.schemas.js';

export const villagesRouter = Router();

villagesRouter.get('/', validate({ query: listVillagesQuerySchema }), controller.list);
villagesRouter.get('/:idOrSlug', validate({ params: villageDetailsParamsSchema }), controller.getByIdOrSlug);
