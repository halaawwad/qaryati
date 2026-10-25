import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './events.controller.js';
import { eventParamsSchema, listEventsQuerySchema, villageEventsParamsSchema } from './events.schemas.js';

export const villageEventsRouter = Router({ mergeParams: true });
export const eventsRouter = Router();

villageEventsRouter.get(
  '/',
  validate({ params: villageEventsParamsSchema, query: listEventsQuerySchema }),
  controller.list,
);

eventsRouter.get('/:id', validate({ params: eventParamsSchema }), controller.getById);
