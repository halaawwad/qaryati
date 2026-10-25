import type { RequestHandler } from 'express';
import type { EventParams, ListEventsQuery, VillageEventsParams } from './events.schemas.js';
import { eventService } from './events.service.js';

export const list: RequestHandler = async (req, res, next) => {
  try {
    const { villageId } = req.params as VillageEventsParams;
    const result = await eventService.list(villageId, req.query as ListEventsQuery);
    res.status(200).json({ data: result.items, meta: result.meta });
  } catch (err) {
    next(err);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as EventParams;
    const event = await eventService.getById(id);
    res.status(200).json({ data: event });
  } catch (err) {
    next(err);
  }
};
