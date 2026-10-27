import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { router } from './routes.js';
import { NotFoundError } from './shared/errors.js';
import { logger } from './shared/logger.js';
import { errorHandler } from './shared/middlewares/errorHandler.js';
import { createRateLimiter } from './shared/middlewares/rateLimit.js';
import { REQUEST_ID_HEADER, requestId } from './shared/middlewares/requestId.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  // requestId and logging run first so every response (including body-parser errors) carries an ID.
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      redact: ['req.headers.authorization'],
      genReqId: (req) => (req as express.Request).requestId,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS.includes('*') ? '*' : env.CORS_ORIGINS,
      exposedHeaders: [REQUEST_ID_HEADER],
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', createRateLimiter('global'), router);

  app.use((req, _res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
  });

  app.use(errorHandler);

  return app;
}
