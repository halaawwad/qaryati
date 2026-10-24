import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './landmarks.controller.js';
import { landmarkParamsSchema, listLandmarksQuerySchema, villageLandmarksParamsSchema } from './landmarks.schemas.js';

export const villageLandmarksRouter = Router({ mergeParams: true });
export const landmarksRouter = Router();

villageLandmarksRouter.get(
  '/',
  validate({ params: villageLandmarksParamsSchema, query: listLandmarksQuerySchema }),
  controller.list,
);

landmarksRouter.get('/:id', validate({ params: landmarkParamsSchema }), controller.getById);
