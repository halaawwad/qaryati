import type { RequestHandler } from 'express';
import type { ListPopulationQuery, PopulationParams, VillagePopulationParams } from './population.schemas.js';
import { populationService } from './population.service.js';
export const list: RequestHandler = async (req, res, next) => { try { const {villageId} = req.params as VillagePopulationParams; const result = await populationService.list(villageId, req.query as ListPopulationQuery); res.status(200).json({data: result.items, meta: result.meta}); } catch (err) { next(err); } };
export const getById: RequestHandler = async (req, res, next) => { try { const {id} = req.params as PopulationParams; res.status(200).json({data: await populationService.getById(id)}); } catch (err) { next(err); } };
