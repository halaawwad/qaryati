import type { RequestHandler } from 'express';
import type { LandmarkParams, ListLandmarksQuery, VillageLandmarksParams } from './landmarks.schemas.js';
import { landmarkService } from './landmarks.service.js';

export const create: RequestHandler = async (req, res, next) => {
  try {
    const { villageId } = req.params as VillageLandmarksParams;
    const landmark = await landmarkService.create(villageId, req.body, {
      actorId: req.user.id, requestId: req.requestId,
    });
    res.status(201).json({ data: landmark });
  } catch (err) {
    next(err);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const { villageId } = req.params as VillageLandmarksParams;
    const result = await landmarkService.list(villageId, req.query as ListLandmarksQuery);
    res.status(200).json({ data: result.items, meta: result.meta });
  } catch (err) {
    next(err);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as LandmarkParams;
    const landmark = await landmarkService.getById(id);
    res.status(200).json({ data: landmark });
  } catch (err) {
    next(err);
  }
};
