import type { Request, RequestHandler } from 'express';
import { villageRelationsService } from './village-relations.service.js';
import type {
  CreateNearbyPlaceInput,
  CreateVillageNameInput,
  NearbyRelationParams,
  UpdateVillageNameInput,
  VillageIdParams,
  VillageNameParams,
} from './villages.schemas.js';
import type { WriteActor } from './villages.service.js';

function actorOf(req: Request): WriteActor {
  return { userId: req.user.id, requestId: req.requestId };
}

// validate() has already replaced req.params and req.body with their parsed values in every handler below.

export const addName: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as VillageIdParams;
    const name = await villageRelationsService.addName(id, req.body as CreateVillageNameInput, actorOf(req));
    res.status(201).json({ data: name });
  } catch (err) {
    next(err);
  }
};

export const updateName: RequestHandler = async (req, res, next) => {
  try {
    const { id, nameId } = req.params as VillageNameParams;
    const name = await villageRelationsService.updateName(id, nameId, req.body as UpdateVillageNameInput, actorOf(req));
    res.status(200).json({ data: name });
  } catch (err) {
    next(err);
  }
};

export const removeName: RequestHandler = async (req, res, next) => {
  try {
    const { id, nameId } = req.params as VillageNameParams;
    await villageRelationsService.removeName(id, nameId, actorOf(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

export const addNearby: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as VillageIdParams;
    const relation = await villageRelationsService.addNearby(id, req.body as CreateNearbyPlaceInput, actorOf(req));
    res.status(201).json({ data: relation });
  } catch (err) {
    next(err);
  }
};

export const removeNearby: RequestHandler = async (req, res, next) => {
  try {
    const { id, relationId } = req.params as NearbyRelationParams;
    await villageRelationsService.removeNearby(id, relationId, actorOf(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};
