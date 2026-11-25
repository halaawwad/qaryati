import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { requireRole } from '../../shared/middlewares/requireRole.js';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './landmarks.controller.js';
import { createLandmarkSchema, updateLandmarkSchema, landmarkParamsSchema, listLandmarksQuerySchema, villageLandmarksParamsSchema } from './landmarks.schemas.js';

export const villageLandmarksRouter = Router({ mergeParams: true });
export const landmarksRouter = Router();

villageLandmarksRouter.post(
  '/',
  authenticate,
  requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ params: villageLandmarksParamsSchema, body: createLandmarkSchema }),
  controller.create,
);

villageLandmarksRouter.get(
  '/',
  validate({ params: villageLandmarksParamsSchema, query: listLandmarksQuerySchema }),
  controller.list,
);

landmarksRouter.get('/:id', validate({ params: landmarkParamsSchema }), controller.getById);
landmarksRouter.patch('/:id', authenticate, requireRole('EDITOR', 'REVIEWER', 'ADMIN'),
  validate({ params: landmarkParamsSchema, body: updateLandmarkSchema }), controller.update);
landmarksRouter.delete('/:id', authenticate, requireRole('ADMIN'),
  validate({ params: landmarkParamsSchema }), controller.remove);
