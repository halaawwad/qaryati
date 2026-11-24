import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { requireRole } from '../../shared/middlewares/requireRole.js';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './economy.controller.js';
import { createEconomySchema, updateEconomySchema, economyParamsSchema, listEconomyQuerySchema, villageEconomyParamsSchema } from './economy.schemas.js';

export const villageEconomyRouter = Router({ mergeParams: true });
export const economyRouter = Router();

villageEconomyRouter.post(
  '/',
  authenticate,
  requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ params: villageEconomyParamsSchema, body: createEconomySchema }),
  controller.create,
);

villageEconomyRouter.get(
  '/',
  validate({ params: villageEconomyParamsSchema, query: listEconomyQuerySchema }),
  controller.list,
);

economyRouter.get('/:id', validate({ params: economyParamsSchema }), controller.getById);
economyRouter.patch('/:id', authenticate, requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ params: economyParamsSchema, body: updateEconomySchema }), controller.update);
economyRouter.delete('/:id', authenticate, requireRole('ADMIN'),
  validate({ params: economyParamsSchema }), controller.remove);
