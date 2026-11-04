import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { requireRole } from '../../shared/middlewares/requireRole.js';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './sources.controller.js';
import { createSourceSchema, deleteSourceSchema, listSourcesQuerySchema, sourceParamsSchema, updateSourceSchema } from './sources.schemas.js';

export const sourcesRouter = Router();

sourcesRouter.post('/', authenticate, requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ body: createSourceSchema }), controller.create);

sourcesRouter.patch('/:id', authenticate, requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ params: sourceParamsSchema, body: updateSourceSchema }), controller.update);

sourcesRouter.delete('/:id', authenticate, requireRole('ADMIN'),
  validate({ params: sourceParamsSchema, body: deleteSourceSchema }), controller.softDelete);

sourcesRouter.get('/', validate({ query: listSourcesQuerySchema }), controller.list);
sourcesRouter.get('/:id', validate({ params: sourceParamsSchema }), controller.getById);
