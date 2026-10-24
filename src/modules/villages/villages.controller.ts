import type { RequestHandler } from 'express';
import type { ListVillagesQuery, VillageDetailsParams } from './villages.schemas.js';
import { villageService } from './villages.service.js';

export const list: RequestHandler = async (req, res, next) => {
  try {
    // validate() has already replaced req.query with the parsed ListVillagesQuery.
    const result = await villageService.list(req.query as ListVillagesQuery);
    res.status(200).json({ data: result.items, meta: result.meta });
  } catch (err) {
    next(err);
  }
};

export const getByIdOrSlug: RequestHandler = async (req, res, next) => {
  try {
    // validate() has already replaced req.params with the parsed VillageDetailsParams.
    const { idOrSlug } = req.params as VillageDetailsParams;
    const village = await villageService.getByIdOrSlug(idOrSlug);
    res.status(200).json({ data: village });
  } catch (err) {
    next(err);
  }
};
