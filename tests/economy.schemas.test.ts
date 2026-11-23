import { EconomicCategory, VerificationStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  economyParamsSchema, listEconomyQuerySchema, villageEconomyParamsSchema,
} from '../src/modules/economy/economy.schemas.js';
import { parsePagination } from '../src/shared/pagination.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('economy schemas', () => {
  it('accepts UUID identifiers', () => {
    expect(villageEconomyParamsSchema.parse({ villageId: id })).toEqual({ villageId: id });
    expect(economyParamsSchema.parse({ id })).toEqual({ id });
  });

  it.each([undefined, '', 'battir', 'not-a-uuid'])('rejects invalid identifiers %j', (value) => {
    expect(villageEconomyParamsSchema.safeParse({ villageId: value }).success).toBe(false);
    expect(economyParamsSchema.safeParse({ id: value }).success).toBe(false);
  });

  it('allows omitted filters and uses shared pagination defaults and cap', () => {
    expect(listEconomyQuerySchema.parse({})).toEqual({});
    expect(parsePagination(listEconomyQuerySchema.parse({}))).toEqual({ page: 1, limit: 20, skip: 0, take: 20 });
    expect(parsePagination(listEconomyQuerySchema.parse({ limit: '500' })).limit).toBe(100);
  });

  it('coerces pagination and trims search without altering literal pattern characters', () => {
    expect(listEconomyQuerySchema.parse({ page: '2', limit: '5', search: '  تراث%_\\  ' })).toEqual({
      page: 2, limit: 5, search: 'تراث%_\\',
    });
    expect(listEconomyQuerySchema.parse({ search: '   ' })).toEqual({ search: undefined });
    expect(listEconomyQuerySchema.parse({ search: 'a'.repeat(100) }).search).toHaveLength(100);
  });

  it.each(Object.values(EconomicCategory))('accepts exact category %s', (category) => {
    expect(listEconomyQuerySchema.parse({ category }).category).toBe(category);
  });

  it.each(Object.values(VerificationStatus))('accepts status %s', (verificationStatus) => {
    expect(listEconomyQuerySchema.parse({ verificationStatus }).verificationStatus).toBe(verificationStatus);
  });

  it.each(['name', 'asOfYear', 'createdAt', 'updatedAt'])('accepts sort %s in both directions', (sort) => {
    for (const order of ['asc', 'desc']) {
      expect(listEconomyQuerySchema.parse({ sort, order })).toEqual({ sort, order });
    }
  });

  it.each([
    { isMajor: '0' }, { isMajor: '1' }, { isMajor: 'False' }, { isMajor: '' }, { isMajor: ['false'] },
    { asOfYear: '' }, { asOfYear: ' ' }, { asOfYear: 'abc' }, { asOfYear: '2014.5' },
    { asOfYear: null }, { asOfYear: true }, { asOfYear: ['2014'] },
    { asOfYear: '2147483648' }, { asOfYear: '-2147483649' },
    { page: '2147483649', limit: '1' }, { page: '9007199254740992' },
    { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: 'abc' },
    { limit: '0' }, { limit: '-1' }, { limit: '1.5' }, { limit: 'abc' },
    { search: 'a'.repeat(101) }, { search: ['one', 'two'] },
    { category: 'craft' }, { category: ' CRAFT ' }, { category: 'UNKNOWN' }, { category: ['CRAFT'] },
    { verificationStatus: 'verified' }, { sort: 'category' }, { sort: 'description' }, { order: 'ASC' },
  ])('rejects invalid query %j', (query) => {
    expect(listEconomyQuerySchema.safeParse(query).success).toBe(false);
  });

  it.each(['true', 'false'])('parses the exact boolean string %s', (isMajor) => {
    expect(listEconomyQuerySchema.parse({ isMajor })).toEqual({ isMajor: isMajor === 'true' });
  });

  it.each(['-2147483648', '-100', '0', '2014', '2147483647'])('accepts integer year %s including zero', (asOfYear) => {
    expect(listEconomyQuerySchema.parse({ asOfYear })).toEqual({ asOfYear: Number(asOfYear) });
  });

  it('allows the maximum safe database offset and checks offsets after the limit cap', () => {
    expect(listEconomyQuerySchema.parse({ page: '2147483648', limit: '1' }).page).toBe(2147483648);
    expect(listEconomyQuerySchema.safeParse({ page: '21474837', limit: '500' }).success).toBe(true);
    expect(listEconomyQuerySchema.safeParse({ page: '21474838', limit: '500' }).success).toBe(false);
  });
});
