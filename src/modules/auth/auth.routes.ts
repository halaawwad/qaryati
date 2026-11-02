import { Router } from 'express';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { createRateLimiter } from '../../shared/middlewares/rateLimit.js';
import { validate } from '../../shared/middlewares/validate.js';
import * as controller from './auth.controller.js';
import { loginSchema, logoutSchema, refreshSchema, registerSchema } from './auth.schemas.js';

export const authRouter = Router();

authRouter.post('/register', createRateLimiter('register'), validate({ body: registerSchema }), controller.register);
authRouter.post('/login', createRateLimiter('login'), validate({ body: loginSchema }), controller.login);
authRouter.post('/refresh', createRateLimiter('refresh'), validate({ body: refreshSchema }), controller.refresh);
authRouter.post('/logout', validate({ body: logoutSchema }), controller.logout);
authRouter.get('/me', authenticate, controller.me);
