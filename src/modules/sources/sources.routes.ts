import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './sources.controller.js';
import { listSourcesQuerySchema, sourceParamsSchema } from './sources.schemas.js';

export const sourcesRouter = Router();

sourcesRouter.get('/', validate({ query: listSourcesQuerySchema }), controller.list);
sourcesRouter.get('/:id', validate({ params: sourceParamsSchema }), controller.getById);
