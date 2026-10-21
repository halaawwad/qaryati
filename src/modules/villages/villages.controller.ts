import type { Request, RequestHandler } from 'express';
import type {
  CreateVillageInput,
  ListVillagesQuery,
  NearbyVillagesQuery,
  UpdateVillageInput,
  VillageDetailsParams,
  VillageIdParams,
  VillageVersionInput,
} from './villages.schemas.js';
import { villageService, type WriteActor } from './villages.service.js';

function actorOf(req: Request): WriteActor {
  return { userId: req.user.id, requestId: req.requestId };
}

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

export const create: RequestHandler = async (req, res, next) => {
  try {
    const village = await villageService.create(req.body as CreateVillageInput, actorOf(req));
    res.status(201).json({ data: village });
  } catch (err) {
    next(err);
  }
};

export const update: RequestHandler = async (req, res, next) => {
  try {
    // validate() has already replaced req.params and req.body with their parsed values.
    const { id } = req.params as VillageIdParams;
    const village = await villageService.update(id, req.body as UpdateVillageInput, actorOf(req));
    res.status(200).json({ data: village });
  } catch (err) {
    next(err);
  }
};

export const remove: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as VillageIdParams;
    await villageService.remove(id, actorOf(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

export const verify: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as VillageIdParams;
    const village = await villageService.verify(id, req.body as VillageVersionInput, actorOf(req));
    res.status(200).json({ data: village });
  } catch (err) {
    next(err);
  }
};

export const reject: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as VillageIdParams;
    const village = await villageService.reject(id, req.body as VillageVersionInput, actorOf(req));
    res.status(200).json({ data: village });
  } catch (err) {
    next(err);
  }
};
