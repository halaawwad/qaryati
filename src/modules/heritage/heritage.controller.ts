import type { RequestHandler } from 'express';
import type { HeritageParams, ListHeritageQuery, VillageHeritageParams } from './heritage.schemas.js';
import { heritageService } from './heritage.service.js';

export const list: RequestHandler = async (req, res, next) => {
  try {
    const { villageId } = req.params as VillageHeritageParams;
    const result = await heritageService.list(villageId, req.query as ListHeritageQuery);
    res.status(200).json({ data: result.items, meta: result.meta });
  } catch (err) {
    next(err);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as HeritageParams;
    const item = await heritageService.getById(id);
    res.status(200).json({ data: item });
  } catch (err) {
    next(err);
  }
};
