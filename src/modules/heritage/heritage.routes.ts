import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { requireRole } from '../../shared/middlewares/requireRole.js';
import * as controller from './heritage.controller.js';
import { createHeritageSchema, updateHeritageSchema, heritageParamsSchema, listHeritageQuerySchema, villageHeritageParamsSchema } from './heritage.schemas.js';

export const villageHeritageRouter = Router({ mergeParams: true });
export const heritageRouter = Router();

villageHeritageRouter.post('/', authenticate, requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ params: villageHeritageParamsSchema, body: createHeritageSchema }), controller.create);
heritageRouter.patch('/:id', authenticate, requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ params: heritageParamsSchema, body: updateHeritageSchema }), controller.update);
heritageRouter.delete('/:id', authenticate, requireRole('ADMIN'),
  validate({ params: heritageParamsSchema }), controller.remove);

villageHeritageRouter.get(
  '/',
  validate({ params: villageHeritageParamsSchema, query: listHeritageQuerySchema }),
  controller.list,
);

heritageRouter.get('/:id', validate({ params: heritageParamsSchema }), controller.getById);
