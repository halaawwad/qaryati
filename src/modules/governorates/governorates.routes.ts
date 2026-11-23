import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './governorates.controller.js';
import { governorateParamsSchema, localAuthoritiesQuerySchema } from './governorates.schemas.js';

export const governoratesRouter = Router();

governoratesRouter.get('/', controller.list);
governoratesRouter.get('/:id', validate({ params: governorateParamsSchema }), controller.getById);
governoratesRouter.get(
  '/:id/local-authorities',
  validate({ params: governorateParamsSchema, query: localAuthoritiesQuerySchema }),
  controller.listLocalAuthorities,
);
