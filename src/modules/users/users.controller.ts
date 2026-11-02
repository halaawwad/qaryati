import type { RequestHandler } from 'express';
import type { ListUsersQuery, UserRole } from './users.schemas.js';
import { userService } from './users.service.js';

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await userService.list(req.query as ListUsersQuery);
    res.status(200).json({ data: result.items, meta: result.meta });
  } catch (err) { next(err); }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    res.status(200).json({ data: await userService.getById(req.params.id as string) });
  } catch (err) { next(err); }
};

export const updateRole: RequestHandler = async (req, res, next) => {
  try {
    const { role } = req.body as { role: UserRole };
    res.status(200).json({ data: await userService.updateRole(req.user.id, req.params.id as string, role) });
  } catch (err) { next(err); }
};

export const updateStatus: RequestHandler = async (req, res, next) => {
  try {
    const { isActive } = req.body as { isActive: boolean };
    res.status(200).json({ data: await userService.updateStatus(req.user.id, req.params.id as string, isActive) });
  } catch (err) { next(err); }
};
