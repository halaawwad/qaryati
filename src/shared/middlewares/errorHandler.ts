import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { isDevelopment } from '../../config/env.js';
import { AppError, type ErrorDetail } from '../errors.js';
import { logger } from '../logger.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details: ErrorDetail[];
    requestId: string;
    stack?: string;
  };
}

interface HttpError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
}

function normalize(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new AppError(
      400,
      'VALIDATION_ERROR',
      'Request validation failed',
      err.issues.map((issue) => ({ field: issue.path.map(String).join('.'), message: issue.message })),
    );
  }

  // Errors raised by Express/body-parser (malformed JSON, payload too large, ...).
  const httpErr = err as HttpError;
  const status = httpErr?.status ?? httpErr?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500 && httpErr.expose !== false) {
    if (httpErr.type === 'entity.parse.failed') {
      return new AppError(400, 'INVALID_JSON', 'Malformed JSON in request body');
    }
    if (httpErr.type === 'entity.too.large') {
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    return new AppError(status, 'BAD_REQUEST', httpErr.message || 'Bad request');
  }

  return new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = normalize(err);

  if (appError.statusCode >= 500) {
    logger.error({ err, requestId: req.requestId }, 'Unhandled error');
  }

  const body: ErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details,
      requestId: req.requestId,
    },
  };

  if (isDevelopment && appError.statusCode >= 500 && err instanceof Error && err.stack) {
    body.error.stack = err.stack;
  }

  res.status(appError.statusCode).json(body);
};
