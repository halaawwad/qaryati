import type { RequestHandler } from 'express';
import type { EventParams, ListEventsQuery, VillageEventsParams } from './events.schemas.js';
import { eventService } from './events.service.js';

export const create: RequestHandler = async (req, res, next) => {
  try {
    const item = await eventService.create(req.params.villageId as string, req.body, {
      actorId: req.user.id, requestId: req.requestId,
    });
    res.status(201).json({ data: item });
  } catch (err) { next(err); }
};
export const update: RequestHandler = async (req, res, next) => {
  try {
    const item = await eventService.update(req.params.id as string, req.body, {
      actorId: req.user.id, role: req.user.role, requestId: req.requestId,
    });
    res.status(200).json({ data: item });
  } catch (err) { next(err); }
};
export const remove: RequestHandler = async (req, res, next) => {
  try {
    await eventService.remove(req.params.id as string, {
      actorId: req.user.id, role: req.user.role, requestId: req.requestId,
    });
    res.status(204).send();
  } catch (err) { next(err); }
};

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
