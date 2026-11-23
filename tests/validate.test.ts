import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../src/shared/errors.js';
import { validate } from '../src/shared/middlewares/validate.js';

function run(schemas: Parameters<typeof validate>[0], req: Partial<Request>) {
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  validate(schemas)(req as Request, {} as Response, next);
  return next;
}

describe('validate middleware', () => {
  it('replaces params, query and body with the parsed values', () => {
    const req: Partial<Request> = { params: { id: '7' }, query: { page: '2' }, body: { name: '  Beita  ', extra: 1 } };
    const next = run({
      params: z.object({ id: z.coerce.number() }),
      query: z.object({ page: z.coerce.number() }),
      body: z.object({ name: z.string().trim() }),
    }, req);

    expect(next).toHaveBeenCalledWith();
    expect(req.params).toEqual({ id: 7 });
    expect(req.query).toEqual({ page: 2 });
    expect(req.body).toEqual({ name: 'Beita' });
  });

  it('collects errors from every part and prefixes each field with its part', () => {
    const req: Partial<Request> = { params: { id: 'x' }, query: {}, body: { email: 'bad' } };
    const next = run({
      params: z.object({ id: z.uuid() }),
      query: z.object({ page: z.string() }),
      body: z.object({ email: z.email(), password: z.string() }),
    }, req);

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(error.details.map((detail: { field: string }) => detail.field)).toEqual([
      'params.id', 'query.page', 'body.email', 'body.password',
    ]);
  });

  it('uses the part name as the field when the whole value is invalid', () => {
    const next = run({ body: z.object({ name: z.string() }) }, { body: undefined });
    expect(next.mock.calls[0]?.[0].details).toEqual([{ field: 'body', message: expect.any(String) }]);
  });

  it('leaves the request untouched when validation fails', () => {
    const body = { name: 123 };
    const req: Partial<Request> = { params: { id: '1' }, body };
    run({ params: z.object({ id: z.coerce.number() }), body: z.object({ name: z.string() }) }, req);
    expect(req.params).toEqual({ id: '1' });
    expect(req.body).toBe(body);
  });

  it('skips parts without a schema', () => {
    const query = { anything: 'goes' };
    const req: Partial<Request> = { query, body: { ok: true } };
    const next = run({ body: z.object({ ok: z.boolean() }) }, req);
    expect(next).toHaveBeenCalledWith();
    expect(req.query).toBe(query);
  });

  it('overrides the Express 5 req.query getter with the coerced values', async () => {
    const app = express();
    app.get('/items', validate({ query: z.object({ page: z.coerce.number(), active: z.enum(['true', 'false']).transform(v => v === 'true') }) }),
      (req, res) => { res.json(req.query); });

    const response = await request(app).get('/items?page=3&active=true');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ page: 3, active: true });
  });
});
