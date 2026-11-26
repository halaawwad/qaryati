import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { requireRole } from '../../shared/middlewares/requireRole.js';
import { validate } from '../../shared/middlewares/validate.js';
import { submit } from './change-requests.controller.js';
import { submitChangeRequestSchema } from './change-requests.schemas.js';
export const changeRequestsRouter=Router();
changeRequestsRouter.post('/',authenticate,requireRole('EDITOR'),validate({body:submitChangeRequestSchema}),submit);
