import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './economy.controller.js';
import { economyParamsSchema, listEconomyQuerySchema, villageEconomyParamsSchema } from './economy.schemas.js';

export const villageEconomyRouter = Router({ mergeParams: true });
export const economyRouter = Router();

villageEconomyRouter.get(
  '/',
  validate({ params: villageEconomyParamsSchema, query: listEconomyQuerySchema }),
  controller.list,
);

economyRouter.get('/:id', validate({ params: economyParamsSchema }), controller.getById);
