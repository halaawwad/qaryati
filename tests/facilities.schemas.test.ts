import { FacilityType, VerificationStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  facilitiesParamsSchema, listFacilitiesQuerySchema, villageFacilitiesParamsSchema,
} from '../src/modules/facilities/facilities.schemas.js';
import { parsePagination } from '../src/shared/pagination.js';

const id = '11111111-1111-4111-8111-111111111111';

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
