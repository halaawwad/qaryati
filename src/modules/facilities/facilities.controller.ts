import type { RequestHandler } from 'express';
import type { FacilitiesParams, ListFacilitiesQuery, VillageFacilitiesParams } from './facilities.schemas.js';
import { facilitiesService } from './facilities.service.js';

export const update: RequestHandler = async (req, res, next) => {
  try {
    const item = await facilitiesService.update(req.params.id as string, req.body, {
      actorId: req.user.id, role: req.user.role, requestId: req.requestId,
    });
    res.status(200).json({ data: item });
  } catch (err) { next(err); }
};

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await facilitiesService.remove(req.params.id as string, {
      actorId: req.user.id, role: req.user.role, requestId: req.requestId,
    });
    res.status(204).send();
  } catch (err) { next(err); }
};

export const create: RequestHandler = async (req, res, next) => {
  try {
    const { villageId } = req.params as VillageFacilitiesParams;
    const item = await facilitiesService.create(villageId, req.body, {
      actorId: req.user.id, requestId: req.requestId,
    });
    res.status(201).json({ data: item });
  } catch (err) {
    next(err);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const { villageId } = req.params as VillageFacilitiesParams;
    const result = await facilitiesService.list(villageId, req.query as ListFacilitiesQuery);
    res.status(200).json({ data: result.items, meta: result.meta });
  } catch (err) {
    next(err);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as FacilitiesParams;
    const item = await facilitiesService.getById(id);
    res.status(200).json({ data: item });
  } catch (err) {
    next(err);
  }
};
