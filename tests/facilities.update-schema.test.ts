import { describe, expect, it } from 'vitest';
import { updateFacilitySchema } from '../src/modules/facilities/facilities.schemas.js';
import { validateFacilitiesTarget } from '../scripts/facilities-integration-safety.mjs';

describe('Facility PATCH schema', () => {
  it.each([
    { version: 1, name: ' School ' }, { version: 1, description: null, asOfYear: null },
    { version: 1, latitude: -90, longitude: -180 }, { version: 1, latitude: 90, longitude: 180 },
    { version: 1, latitude: 0, longitude: 0 }, { version: 1, latitude: null, longitude: null },
    { version: 2147483646, asOfYear: -2147483648 }, { version: 1, asOfYear: 2147483647 },
  ])('accepts valid partial update %j', body => expect(updateFacilitySchema.safeParse(body).success).toBe(true));
  it.each([
    {}, { version: 1 }, { name: 'School' }, { version: 0, name: 'School' },
    { version: 1.5, name: 'School' }, { version: '1', name: 'School' }, { version: 2147483647, name: 'School' },
    { version: 1, name: ' ' }, { version: 1, name: 'x'.repeat(201) },
    { version: 1, description: 'x'.repeat(5001) }, { version: 1, sourceId: null },
    { version: 1, facilityType: 'INVALID' }, { version: 1, asOfYear: 2147483648 },
    { version: 1, latitude: 0 }, { version: 1, longitude: 0 },
    { version: 1, latitude: null }, { version: 1, longitude: null },
    { version: 1, latitude: null, longitude: 0 }, { version: 1, latitude: 0, longitude: null },
    { version: 1, latitude: 90.01, longitude: 0 }, { version: 1, latitude: 0, longitude: -180.01 },
    ...['verificationStatus', 'createdById', 'updatedById', 'deletedAt', 'id', 'villageId', 'unknown'].map(key =>
      ({ version: 1, name: 'School', [key]: 'protected' })),
  ])('rejects invalid partial update %j', body => expect(updateFacilitySchema.safeParse(body).success).toBe(false));
  it('preserves omission and trims strings', () => {
    expect(updateFacilitySchema.parse({ version: 1, name: ' School ' })).toEqual({ version: 1, name: 'School' });
  });
});

describe('Facilities disposable target guard', () => {
  const token = 'a'.repeat(24);
  const name = `facilities_it_${token}`;
  const env = { QARYATI_FACILITIES_RUN: token,
    DATABASE_URL: `postgresql://${name}:${'b'.repeat(48)}@127.0.0.1:55123/${name}`,
    REDIS_URL: 'redis://127.0.0.1:55124/0' };
  it('accepts run-specific localhost targets', () => expect(validateFacilitiesTarget(env)).toEqual({ token, name }));
  it.each([
    { QARYATI_FACILITIES_RUN: undefined }, { DATABASE_URL: 'postgresql://user:pass@localhost:5432/qaryati' },
    { DATABASE_URL: env.DATABASE_URL.replace('/' + name, '/qaryati_local') },
    { DATABASE_URL: env.DATABASE_URL.replace('127.0.0.1', 'db.example.com') },
    { DATABASE_URL: env.DATABASE_URL + '?schema=public' },
    { REDIS_URL: 'redis://localhost:6379/0' }, { REDIS_URL: 'redis://127.0.0.1:55124/1' },
    { REDIS_URL: 'redis://127.0.0.1:55123/0' },
  ])('rejects unsafe targets %j', override => expect(() => validateFacilitiesTarget({ ...env, ...override })).toThrow());
});
