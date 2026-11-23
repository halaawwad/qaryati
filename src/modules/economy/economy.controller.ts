import type { RequestHandler } from 'express';
import type { EconomyParams, ListEconomyQuery, VillageEconomyParams } from './economy.schemas.js';
import { economyService } from './economy.service.js';

export const create: RequestHandler = async (req, res, next) => {
  try {
    const { villageId } = req.params as VillageEconomyParams;
    const item = await economyService.create(villageId, req.body, {
      actorId: req.user.id, requestId: req.requestId,
    });
    res.status(201).json({ data: item });
  } catch (err) {
    next(err);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const { villageId } = req.params as VillageEconomyParams;
    const result = await economyService.list(villageId, req.query as ListEconomyQuery);
    res.status(200).json({ data: result.items, meta: result.meta });
  } catch (err) {
    next(err);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as EconomyParams;
    const item = await economyService.getById(id);
    res.status(200).json({ data: item });
  } catch (err) {
    next(err);
  }
};
