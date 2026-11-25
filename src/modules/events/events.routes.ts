import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { requireRole } from '../../shared/middlewares/requireRole.js';
import * as controller from './events.controller.js';
import { createEventSchema, updateEventSchema, eventParamsSchema, listEventsQuerySchema, villageEventsParamsSchema } from './events.schemas.js';

export const villageEventsRouter = Router({ mergeParams: true });
export const eventsRouter = Router();

villageEventsRouter.post('/', authenticate, requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ params: villageEventsParamsSchema, body: createEventSchema }), controller.create);
eventsRouter.patch('/:id', authenticate, requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ params: eventParamsSchema, body: updateEventSchema }), controller.update);
eventsRouter.delete('/:id', authenticate, requireRole('ADMIN'),
  validate({ params: eventParamsSchema }), controller.remove);

villageEventsRouter.get(
  '/',
  validate({ params: villageEventsParamsSchema, query: listEventsQuerySchema }),
  controller.list,
);

eventsRouter.get('/:id', validate({ params: eventParamsSchema }), controller.getById);
