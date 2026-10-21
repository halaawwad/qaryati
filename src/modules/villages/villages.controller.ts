import type { RequestHandler } from 'express';
import type { ListVillagesQuery } from './villages.schemas.js';
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
