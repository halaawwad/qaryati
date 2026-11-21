import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './heritage.controller.js';
import { heritageParamsSchema, listHeritageQuerySchema, villageHeritageParamsSchema } from './heritage.schemas.js';

export const villageHeritageRouter = Router({ mergeParams: true });
export const heritageRouter = Router();

villageHeritageRouter.get(
  '/',
  validate({ params: villageHeritageParamsSchema, query: listHeritageQuerySchema }),
  controller.list,
);

heritageRouter.get('/:id', validate({ params: heritageParamsSchema }), controller.getById);
