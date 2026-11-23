import type { RequestHandler } from 'express';
import type { GovernorateParams, LocalAuthoritiesQuery } from './governorates.schemas.js';
import { governorateService } from './governorates.service.js';

export const list: RequestHandler = async (_req, res, next) => {
  try {
    const governorates = await governorateService.list();
    res.status(200).json({ data: governorates });
  } catch (err) {
    next(err);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    // validate() has already replaced req.params with the parsed GovernorateParams.
    const { id } = req.params as GovernorateParams;
    const governorate = await governorateService.getById(id);
    res.status(200).json({ data: governorate });
  } catch (err) {
    next(err);
  }
};

export const listLocalAuthorities: RequestHandler = async (req, res, next) => {
  try {
    // validate() has already replaced req.params and req.query with their parsed values.
    const { id } = req.params as GovernorateParams;
    const localAuthorities = await governorateService.listLocalAuthorities(id, req.query as LocalAuthoritiesQuery);
    res.status(200).json({ data: localAuthorities });
  } catch (err) {
    next(err);
  }
};
