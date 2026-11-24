import type { RequestHandler } from 'express';
import type { ListVillagesQuery, NearbyVillagesQuery, VillageDetailsParams } from './villages.schemas.js';
import { villageService } from './villages.service.js';
import { villageGeoService } from './villages.geo.service.js';

export const geoCandidates: RequestHandler = async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try { res.status(200).json({ data: await villageGeoService.candidates(req.params.id as string) }); }
  catch (error) { next(error); }
};
export const applyGeoEnrichment: RequestHandler = async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    const data = await villageGeoService.apply(req.params.id as string, req.body, { actorId: req.user.id, requestId: req.requestId });
    res.status(200).json({ data });
  } catch (error) { next(error); }
};

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

export const listNearby: RequestHandler = async (req, res, next) => {
  try {
    // validate() has already replaced req.params and req.query with their parsed values.
    const { idOrSlug } = req.params as VillageDetailsParams;
    const nearby = await villageService.listNearby(idOrSlug, req.query as NearbyVillagesQuery);
    res.status(200).json({ data: nearby });
  } catch (err) {
    next(err);
  }
};
