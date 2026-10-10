import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { ValidationError, type ErrorDetail } from '../errors.js';

type RequestPart = 'params' | 'query' | 'body';

export type ValidationSchemas = Partial<Record<RequestPart, ZodType>>;

const PARTS: RequestPart[] = ['params', 'query', 'body'];

/**
 * Validates and coerces request params/query/body against zod schemas.
 * On success the parsed values replace the originals; on failure a ValidationError is raised.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const details: ErrorDetail[] = [];
    const parsed: Partial<Record<RequestPart, unknown>> = {};

    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (result.success) {
        parsed[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          const path = issue.path.map(String).join('.');
          details.push({ field: path ? `${part}.${path}` : part, message: issue.message });
        }
      }
    }

    if (details.length > 0) {
      next(new ValidationError('Request validation failed', details));
      return;
    }

    for (const part of PARTS) {
      if (!(part in parsed)) continue;
      // Express 5 exposes req.query as a getter, so redefine instead of assigning.
      Object.defineProperty(req, part, {
        value: parsed[part],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    next();
  };
}
