import { VerificationStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  EVENT_SORT_FIELDS,
  eventParamsSchema,
  listEventsQuerySchema,
  villageEventsParamsSchema,
} from '../src/modules/events/events.schemas.js';
import { parsePagination } from '../src/shared/pagination.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('event params schemas', () => {
  it('accepts UUID village and event identifiers', () => {
    expect(villageEventsParamsSchema.parse({ villageId: id })).toEqual({ villageId: id });
    expect(eventParamsSchema.parse({ id })).toEqual({ id });
  });

  it.each([undefined, '', 'battir', 'not-a-uuid'])('rejects invalid identifiers: %j', (value) => {
    expect(villageEventsParamsSchema.safeParse({ villageId: value }).success).toBe(false);
    expect(eventParamsSchema.safeParse({ id: value }).success).toBe(false);
  });
});

describe('listEventsQuerySchema', () => {
  it('keeps filters optional and lets shared pagination provide defaults', () => {
    const query = listEventsQuerySchema.parse({});
    expect(query).toEqual({});
    expect(parsePagination(query)).toEqual({ page: 1, limit: 20, skip: 0, take: 20 });
  });

  it('coerces numbers, trims text, and preserves an explicit false filter', () => {
    expect(listEventsQuerySchema.parse({
      page: '2', limit: '5', search: '  التراث  ', category: '  Heritage  ',
      verificationStatus: VerificationStatus.PENDING, isApproximate: 'false', yearFrom: '-100', yearTo: '0',
    })).toEqual({
      page: 2, limit: 5, search: 'التراث', category: 'Heritage',
      verificationStatus: VerificationStatus.PENDING, isApproximate: false, yearFrom: -100, yearTo: 0,
    });
  });

  it('parses true and treats whitespace-only search as absent', () => {
    expect(listEventsQuerySchema.parse({ search: '  ', isApproximate: 'true' })).toEqual({
      search: undefined, isApproximate: true,
    });
  });

  it('accepts a limit above 100 for shared pagination to cap', () => {
    expect(parsePagination(listEventsQuerySchema.parse({ limit: '500' })).limit).toBe(100);
  });

  it.each(['-2147483648', '2147483647', '-1', '0'])('accepts equal inclusive year bounds %s', (year) => {
    expect(listEventsQuerySchema.parse({ yearFrom: year, yearTo: year })).toEqual({
      yearFrom: Number(year), yearTo: Number(year),
    });
  });

  it('accepts either year bound independently', () => {
    expect(listEventsQuerySchema.parse({ yearFrom: '-500' })).toEqual({ yearFrom: -500 });
    expect(listEventsQuerySchema.parse({ yearTo: '2026' })).toEqual({ yearTo: 2026 });
  });

  it('rejects an inverted range with a yearTo validation issue', () => {
    const result = listEventsQuerySchema.safeParse({ yearFrom: '2026', yearTo: '2014' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['yearTo']);
  });

  it.each(['-2147483649', '2147483648', '1.5', 'abc', '', '   ', null, true, ['2026']])(
    'rejects invalid year bounds %j', (value) => {
      expect(listEventsQuerySchema.safeParse({ yearFrom: value }).success).toBe(false);
      expect(listEventsQuerySchema.safeParse({ yearTo: value }).success).toBe(false);
    },
  );

  it.each(['False', 'TRUE', '0', '1', '', true, false, ['false']])('rejects non-explicit boolean %j', (value) => {
    expect(listEventsQuerySchema.safeParse({ isApproximate: value }).success).toBe(false);
  });

  it.each(EVENT_SORT_FIELDS)('accepts supported sort %s in either direction', (sort) => {
    for (const order of ['asc', 'desc']) {
      expect(listEventsQuerySchema.parse({ sort, order })).toEqual({ sort, order });
    }
  });

  it('accepts the maximum search and category lengths', () => {
    expect(listEventsQuerySchema.safeParse({ search: 'a'.repeat(100), category: 'b'.repeat(100) }).success).toBe(true);
  });

  it.each([
    { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: 'abc' },
    { limit: '0' }, { limit: '-1' }, { limit: '1.5' }, { limit: 'abc' },
    { search: 'a'.repeat(101) }, { search: ['one', 'two'] },
    { category: 'a'.repeat(101) }, { category: '   ' }, { category: ['heritage'] },
    { verificationStatus: 'UNKNOWN' }, { sort: 'description' }, { order: 'sideways' },
  ])('rejects invalid query %j', (query) => {
    expect(listEventsQuerySchema.safeParse(query).success).toBe(false);
  });
});
