import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './population.controller.js';
import { listPopulationQuerySchema, populationParamsSchema, villagePopulationParamsSchema } from './population.schemas.js';
export const villagePopulationRouter = Router({mergeParams: true});
export const populationRouter = Router();
villagePopulationRouter.get('/', validate({params: villagePopulationParamsSchema, query: listPopulationQuerySchema}), controller.list);
populationRouter.get('/:id', validate({params: populationParamsSchema}), controller.getById);
