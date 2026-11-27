import { describe, expect, it } from 'vitest';
import { createHeritageSchema, updateHeritageSchema } from '../src/modules/heritage/heritage.schemas.js';
import { validateHeritageTarget } from '../scripts/heritage-integration-safety.mjs';
describe('Heritage write schemas', () => {
  it.each(['CRAFT','FOOD','AGRI_PRACTICE','CUSTOM','OTHER'])('accepts category %s and optional nullable fields', category => {
    expect(createHeritageSchema.parse({ name: ' Item ', category })).toEqual({ name: 'Item', category });
    expect(createHeritageSchema.parse({ name: 'Item', category, description: null, sourceId: null })).toMatchObject({ description: null, sourceId: null });
  });
  it('preserves omitted fields and supports clearing description/source', () => {
    expect(updateHeritageSchema.parse({ version: 1, name: ' New ' })).toEqual({ version: 1, name: 'New' });
    expect(updateHeritageSchema.parse({ version: 1, description: null, sourceId: null })).toEqual({ version: 1, description: null, sourceId: null });
  });
  it.each([{}, { name: 'Item' }, { category: 'CRAFT' }, { name: ' ', category: 'CRAFT' },
    { name: 'x'.repeat(201), category: 'CRAFT' }, { name: 'Item', category: 'craft' },
    { name: 'Item', category: null }, { name: null, category: 'CRAFT' },
    { name: 'Item', category: 'CRAFT', sourceId: 'invalid' },
    { name: 'Item', category: 'CRAFT', description: 'x'.repeat(5001) },
    { name: 'Item', category: 'CRAFT', version: 1 }])('rejects invalid creation %j', body => {
    expect(createHeritageSchema.safeParse(body).success).toBe(false);
  });
  it.each([{}, { version: 1 }, { name: 'X' }, { version: 0, name: 'X' }, { version: '1', name: 'X' },
    { version: 1.5, name: 'X' }, { version: 2147483647, name: 'X' },
    { version: 1, name: null }, { version: 1, category: null }])('rejects invalid PATCH %j', body => {
    expect(updateHeritageSchema.safeParse(body).success).toBe(false);
  });
  it.each(['verificationStatus','createdById','updatedById','deletedAt','villageId','id','unknown'])(
    'rejects protected field %s', key => {
      expect(createHeritageSchema.safeParse({ name: 'X', category: 'CRAFT', [key]: 'protected' }).success).toBe(false);
      expect(updateHeritageSchema.safeParse({ version: 1, name: 'X', [key]: 'protected' }).success).toBe(false);
    });
});
describe('Heritage disposable target guard', () => {
  const token = 'a'.repeat(24), name = `heritage_it_${token}`;
  const env = { QARYATI_HERITAGE_RUN: token, DATABASE_URL: `postgresql://${name}:${'b'.repeat(48)}@127.0.0.1:55123/${name}`, REDIS_URL: 'redis://127.0.0.1:55124/0' };
  it('accepts run-specific local targets', () => expect(validateHeritageTarget(env)).toEqual({ token, name }));
  it.each([{ QARYATI_HERITAGE_RUN: undefined }, { DATABASE_URL: 'postgresql://user:pass@localhost:5432/qaryati' },
    { DATABASE_URL: env.DATABASE_URL.replace('/' + name, '/qaryati_local') }, { DATABASE_URL: env.DATABASE_URL + '?schema=public' },
    { DATABASE_URL: env.DATABASE_URL.replace('127.0.0.1', 'db.example.com') },
    { REDIS_URL: 'redis://localhost:6379/0' }, { REDIS_URL: 'redis://127.0.0.1:55124/1' }, { REDIS_URL: 'redis://127.0.0.1:55123/0' }])(
    'rejects unsafe targets %j', override => expect(() => validateHeritageTarget({ ...env, ...override })).toThrow());
});
