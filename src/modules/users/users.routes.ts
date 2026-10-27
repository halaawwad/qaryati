import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { requireRole } from '../../shared/middlewares/requireRole.js';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './users.controller.js';
import { listUsersQuerySchema, updateRoleSchema, updateStatusSchema, userParamsSchema } from './users.schemas.js';

export const usersRouter = Router();
usersRouter.use(authenticate, requireRole('ADMIN'));
usersRouter.get('/', validate({ query: listUsersQuerySchema }), controller.list);
usersRouter.get('/:id', validate({ params: userParamsSchema }), controller.getById);
usersRouter.patch('/:id/role', validate({ params: userParamsSchema, body: updateRoleSchema }), controller.updateRole);
usersRouter.patch('/:id/status', validate({ params: userParamsSchema, body: updateStatusSchema }), controller.updateStatus);
