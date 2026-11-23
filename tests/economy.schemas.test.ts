import { EconomicCategory, VerificationStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  createEconomySchema, economyParamsSchema, listEconomyQuerySchema, villageEconomyParamsSchema,
} from '../src/modules/economy/economy.schemas.js';
import { parsePagination } from '../src/shared/pagination.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('create economy schema', () => {
  const input = { name: 'Village crafts', category: EconomicCategory.CRAFT, sourceId: id };

  it('trims text, defaults isMajor and preserves omitted nullable fields', () => {
    expect(createEconomySchema.parse({ ...input, name: ' Village crafts ' })).toEqual({ ...input, isMajor: false });
    expect(createEconomySchema.parse({ ...input, description: '   ', asOfYear: null })).toEqual({
      ...input, description: '', asOfYear: null, isMajor: false,
    });
  });

  it('accepts text limits after trimming and preserves false and year zero', () => {
    expect(createEconomySchema.parse({
      ...input, name: ' ' + 'a'.repeat(200) + ' ', description: ' ' + 'b'.repeat(5000) + ' ',
      isMajor: false, asOfYear: 0,
    })).toMatchObject({ name: 'a'.repeat(200), description: 'b'.repeat(5000), isMajor: false, asOfYear: 0 });
  });

  it.each(Object.values(EconomicCategory))('accepts category %s', category => {
    expect(createEconomySchema.parse({ ...input, category }).category).toBe(category);
  });

  it.each([-2147483648, -1, 0, 2147483647, null])('accepts year %s', asOfYear => {
    expect(createEconomySchema.parse({ ...input, asOfYear }).asOfYear).toBe(asOfYear);
  });

  it.each([
    { name: '' }, { name: ' ' }, { name: null }, { name: 123 }, { name: 'a'.repeat(201) },
    { category: 'craft' }, { category: ' CRAFT ' }, { sourceId: null }, { sourceId: 'invalid' },
    { description: null }, { description: 123 }, { description: 'a'.repeat(5001) },
    { isMajor: 'false' }, { isMajor: 0 }, { isMajor: null },
    { asOfYear: '2014' }, { asOfYear: true }, { asOfYear: 1.5 },
    { asOfYear: -2147483649 }, { asOfYear: 2147483648 }, { asOfYear: NaN }, { asOfYear: Infinity },
  ])('rejects invalid field values %j without coercion', fields => {
    expect(createEconomySchema.safeParse({ ...input, ...fields }).success).toBe(false);
  });

  it.each(['name', 'category', 'sourceId'] as const)('requires %s', field => {
    const { [field]: _omitted, ...body } = input;
    expect(createEconomySchema.safeParse(body).success).toBe(false);
  });

  it.each(['id', 'villageId', 'createdById', 'updatedById', 'verificationStatus', 'version',
    'createdAt', 'updatedAt', 'deletedAt', 'actorId', 'requestId', 'village', 'source', 'unexpected'])
  ('rejects protected or unknown field %s', field => {
    expect(createEconomySchema.safeParse({ ...input, [field]: 'spoofed' }).success).toBe(false);
  });

  it.each([null, [], 'text', 123])('rejects a non-object body %j', body => {
    expect(createEconomySchema.safeParse(body).success).toBe(false);
  });
});

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
