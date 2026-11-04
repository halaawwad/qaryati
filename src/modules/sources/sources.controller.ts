import type { RequestHandler } from 'express';
import type { ListSourcesQuery, SourceParams } from './sources.schemas.js';
import { sourceService } from './sources.service.js';

export const softDelete: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as SourceParams;
    const result = await sourceService.softDelete(id, req.body, {
      actorId: req.user.id, role: req.user.role, requestId: req.requestId,
    });
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const update: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as SourceParams;
    const source = await sourceService.update(id, req.body, {
      actorId: req.user.id, role: req.user.role, requestId: req.requestId,
    });
    res.status(200).json({ data: source });
  } catch (err) {
    next(err);
  }
};

export const create: RequestHandler = async (req, res, next) => {
  try {
    const source = await sourceService.create(req.body, { actorId: req.user.id, requestId: req.requestId });
    res.status(201).json({ data: source });
  } catch (err) {
    next(err);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await sourceService.list(req.query as ListSourcesQuery);
    res.status(200).json({ data: result.items, meta: result.meta });
  } catch (err) {
    next(err);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as SourceParams;
    const source = await sourceService.getById(id);
    res.status(200).json({ data: source });
  } catch (err) {
    next(err);
  }
};
