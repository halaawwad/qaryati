import { FacilityType, VerificationStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  createFacilitySchema, facilitiesParamsSchema, listFacilitiesQuerySchema, villageFacilitiesParamsSchema,
} from '../src/modules/facilities/facilities.schemas.js';
import { parsePagination } from '../src/shared/pagination.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('create facility schema', () => {
  const required = { name: '  مدرسة القرية  ', facilityType: FacilityType.SCHOOL, sourceId: id };

  it('trims text and preserves optional omissions and supplied precision', () => {
    expect(createFacilitySchema.parse(required)).toEqual({ ...required, name: 'مدرسة القرية' });
    expect(createFacilitySchema.parse({
      ...required, description: '  ', latitude: 32.123456789, longitude: -35.987654321,
    })).toMatchObject({ description: '', latitude: 32.123456789, longitude: -35.987654321 });
  });

  it.each(Object.values(FacilityType))('accepts exact type %s', facilityType => {
    expect(createFacilitySchema.parse({ ...required, facilityType }).facilityType).toBe(facilityType);
  });

  it.each([undefined, null, 0].flatMap(latitude =>
    [undefined, null, 0].map(longitude => ({ latitude, longitude })),
  ))('validates all omitted/null/number coordinate combinations: %j', coordinates => {
    const result = createFacilitySchema.safeParse({ ...required, ...coordinates });
    const valid = (typeof coordinates.latitude === 'number') === (typeof coordinates.longitude === 'number');
    expect(result.success).toBe(valid);
    if (!valid) {
      expect(result.error?.issues[0]?.path).toEqual([
        typeof coordinates.latitude === 'number' ? 'longitude' : 'latitude',
      ]);
    }
  });

  it.each([
    { latitude: -90, longitude: -180 }, { latitude: 90, longitude: 180 },
  ])('accepts coordinate boundaries %j', coordinates => {
    expect(createFacilitySchema.parse({ ...required, ...coordinates })).toMatchObject(coordinates);
  });

  it.each(['latitude', 'longitude'] as const)('rejects nonnumeric and nonfinite %s', field => {
    for (const value of [NaN, Infinity, -Infinity, '', '0', true, [], {}]) {
      expect(createFacilitySchema.safeParse({ ...required, latitude: 0, longitude: 0, [field]: value }).success).toBe(false);
    }
  });

  it.each([
    { latitude: -90.000001, longitude: 0 }, { latitude: 90.000001, longitude: 0 },
    { latitude: 0, longitude: -180.000001 }, { latitude: 0, longitude: 180.000001 },
  ])('rejects coordinates beyond bounds before database rounding %j', coordinates => {
    expect(createFacilitySchema.safeParse({ ...required, ...coordinates }).success).toBe(false);
  });

  it.each([null, -2147483648, -1, 0, 2147483647])('accepts year %j', asOfYear => {
    expect(createFacilitySchema.parse({ ...required, asOfYear }).asOfYear).toBe(asOfYear);
  });

  it.each(['0', true, 0.5, -2147483649, 2147483648, NaN, Infinity])('rejects invalid year %j', asOfYear => {
    expect(createFacilitySchema.safeParse({ ...required, asOfYear }).success).toBe(false);
  });

  it('applies trimmed text limits and rejects null description', () => {
    expect(createFacilitySchema.parse({ ...required, name: ` ${'أ'.repeat(200)} `, description: ` ${'أ'.repeat(5000)} ` }).name).toHaveLength(200);
    for (const patch of [{ name: ' ' }, { name: 'a'.repeat(201) }, { description: null }, { description: 'a'.repeat(5001) }]) {
      expect(createFacilitySchema.safeParse({ ...required, ...patch }).success).toBe(false);
    }
  });

  it.each(['name', 'facilityType', 'sourceId'])('requires %s', field => {
    expect(createFacilitySchema.safeParse({ ...required, [field]: undefined }).success).toBe(false);
  });

  it.each(['id', 'villageId', 'createdById', 'updatedById', 'verificationStatus', 'version', 'deletedAt', 'createdAt', 'updatedAt', 'unexpected'])('rejects protected or unknown field %s', field => {
    expect(createFacilitySchema.safeParse({ ...required, [field]: null }).success).toBe(false);
  });
});

describe('facilities schemas', () => {
  it('accepts UUID identifiers', () => {
    expect(villageFacilitiesParamsSchema.parse({ villageId: id })).toEqual({ villageId: id });
    expect(facilitiesParamsSchema.parse({ id })).toEqual({ id });
  });

  it.each([undefined, '', 'battir', 'not-a-uuid'])('rejects invalid identifiers %j', (value) => {
    expect(villageFacilitiesParamsSchema.safeParse({ villageId: value }).success).toBe(false);
    expect(facilitiesParamsSchema.safeParse({ id: value }).success).toBe(false);
  });

  it('allows omitted filters and uses shared pagination defaults and cap', () => {
    expect(listFacilitiesQuerySchema.parse({})).toEqual({});
    expect(parsePagination(listFacilitiesQuerySchema.parse({}))).toEqual({ page: 1, limit: 20, skip: 0, take: 20 });
    expect(parsePagination(listFacilitiesQuerySchema.parse({ limit: '500' })).limit).toBe(100);
  });

  it('coerces pagination and trims search without altering literal pattern characters', () => {
    expect(listFacilitiesQuerySchema.parse({ page: '2', limit: '5', search: '  تراث%_\\  ' })).toEqual({
      page: 2, limit: 5, search: 'تراث%_\\',
    });
    expect(listFacilitiesQuerySchema.parse({ search: '   ' })).toEqual({ search: undefined });
    expect(listFacilitiesQuerySchema.parse({ search: 'a'.repeat(100) }).search).toHaveLength(100);
  });

  it.each(Object.values(FacilityType))('accepts exact facilityType %s', (facilityType) => {
    expect(listFacilitiesQuerySchema.parse({ facilityType }).facilityType).toBe(facilityType);
  });

  it.each(Object.values(VerificationStatus))('accepts status %s', (verificationStatus) => {
    expect(listFacilitiesQuerySchema.parse({ verificationStatus }).verificationStatus).toBe(verificationStatus);
  });

  it.each(['name', 'asOfYear', 'createdAt', 'updatedAt'])('accepts sort %s in both directions', (sort) => {
    for (const order of ['asc', 'desc']) {
      expect(listFacilitiesQuerySchema.parse({ sort, order })).toEqual({ sort, order });
    }
  });

  it.each([
    { asOfYear: '' }, { asOfYear: ' ' }, { asOfYear: 'abc' }, { asOfYear: '2014.5' },
    { asOfYear: null }, { asOfYear: true }, { asOfYear: ['2014'] },
    { asOfYear: '2147483648' }, { asOfYear: '-2147483649' },
    { page: '2147483649', limit: '1' }, { page: '9007199254740992' },
    { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: 'abc' },
    { limit: '0' }, { limit: '-1' }, { limit: '1.5' }, { limit: 'abc' },
    { search: 'a'.repeat(101) }, { search: ['one', 'two'] },
    { facilityType: 'school' }, { facilityType: ' SCHOOL ' }, { facilityType: 'UNKNOWN' }, { facilityType: ['SCHOOL'] },
    { verificationStatus: 'verified' }, { sort: 'facilityType' }, { sort: 'description' }, { order: 'ASC' },
  ])('rejects invalid query %j', (query) => {
    expect(listFacilitiesQuerySchema.safeParse(query).success).toBe(false);
  });

  it.each(['-2147483648', '-100', '0', '2014', '2147483647'])('accepts signed integer year %s', asOfYear => {
    expect(listFacilitiesQuerySchema.parse({ asOfYear })).toEqual({ asOfYear: Number(asOfYear) });
  });

  it('validates offsets after defaults and the limit cap', () => {
    expect(listFacilitiesQuerySchema.parse({ page: '2147483648', limit: '1' }).page).toBe(2147483648);
    expect(listFacilitiesQuerySchema.safeParse({ page: '21474837', limit: '500' }).success).toBe(true);
    const invalid = listFacilitiesQuerySchema.safeParse({ page: '21474838', limit: '500' });
    expect(invalid.success).toBe(false);
    expect(invalid.error?.issues[0]?.path).toEqual(['page']);
  });
});
