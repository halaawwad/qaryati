import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { requireRole } from '../../shared/middlewares/requireRole.js';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './sources.controller.js';
import { createSourceSchema, listSourcesQuerySchema, sourceParamsSchema } from './sources.schemas.js';

export const sourcesRouter = Router();

sourcesRouter.post('/', authenticate, requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ body: createSourceSchema }), controller.create);

sourcesRouter.get('/', validate({ query: listSourcesQuerySchema }), controller.list);
sourcesRouter.get('/:id', validate({ params: sourceParamsSchema }), controller.getById);
