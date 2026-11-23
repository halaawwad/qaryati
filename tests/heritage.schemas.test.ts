import { HeritageCategory, VerificationStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  heritageParamsSchema, listHeritageQuerySchema, villageHeritageParamsSchema,
} from '../src/modules/heritage/heritage.schemas.js';
import { parsePagination } from '../src/shared/pagination.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('heritage schemas', () => {
  it('accepts UUID identifiers', () => {
    expect(villageHeritageParamsSchema.parse({ villageId: id })).toEqual({ villageId: id });
    expect(heritageParamsSchema.parse({ id })).toEqual({ id });
  });

  it.each([undefined, '', 'battir', 'not-a-uuid'])('rejects invalid identifiers %j', (value) => {
    expect(villageHeritageParamsSchema.safeParse({ villageId: value }).success).toBe(false);
    expect(heritageParamsSchema.safeParse({ id: value }).success).toBe(false);
  });

  it('allows omitted filters and uses shared pagination defaults and cap', () => {
    expect(listHeritageQuerySchema.parse({})).toEqual({});
    expect(parsePagination(listHeritageQuerySchema.parse({}))).toEqual({ page: 1, limit: 20, skip: 0, take: 20 });
    expect(parsePagination(listHeritageQuerySchema.parse({ limit: '500' })).limit).toBe(100);
  });

  it('coerces pagination and trims search without altering literal pattern characters', () => {
    expect(listHeritageQuerySchema.parse({ page: '2', limit: '5', search: '  تراث%_\\  ' })).toEqual({
      page: 2, limit: 5, search: 'تراث%_\\',
    });
    expect(listHeritageQuerySchema.parse({ search: '   ' })).toEqual({ search: undefined });
    expect(listHeritageQuerySchema.parse({ search: 'a'.repeat(100) }).search).toHaveLength(100);
  });

  it.each(Object.values(HeritageCategory))('accepts exact category %s', (category) => {
    expect(listHeritageQuerySchema.parse({ category }).category).toBe(category);
  });

  it.each(Object.values(VerificationStatus))('accepts status %s', (verificationStatus) => {
    expect(listHeritageQuerySchema.parse({ verificationStatus }).verificationStatus).toBe(verificationStatus);
  });

  it.each(['name', 'createdAt', 'updatedAt'])('accepts sort %s in both directions', (sort) => {
    for (const order of ['asc', 'desc']) {
      expect(listHeritageQuerySchema.parse({ sort, order })).toEqual({ sort, order });
    }
  });

  it.each([
    { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: 'abc' },
    { limit: '0' }, { limit: '-1' }, { limit: '1.5' }, { limit: 'abc' },
    { search: 'a'.repeat(101) }, { search: ['one', 'two'] },
    { category: 'craft' }, { category: ' CRAFT ' }, { category: 'UNKNOWN' }, { category: ['CRAFT'] },
    { verificationStatus: 'verified' }, { sort: 'category' }, { sort: 'description' }, { order: 'ASC' },
  ])('rejects invalid query %j', (query) => {
    expect(listHeritageQuerySchema.safeParse(query).success).toBe(false);
  });
});
