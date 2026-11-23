import { describe, expect, it } from 'vitest';
import { buildPaginationMeta, DEFAULT_LIMIT, MAX_LIMIT, parsePagination } from '../src/shared/pagination.js';

describe('parsePagination', () => {
  it('applies defaults when page and limit are missing', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: DEFAULT_LIMIT, skip: 0, take: DEFAULT_LIMIT });
  });

  it('accepts numeric strings from the query string', () => {
    expect(parsePagination({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10, skip: 20, take: 10 });
  });

  it('caps the limit at MAX_LIMIT instead of rejecting it', () => {
    expect(parsePagination({ page: 2, limit: 500 })).toEqual({ page: 2, limit: MAX_LIMIT, skip: MAX_LIMIT, take: MAX_LIMIT });
  });

  it.each([0, -1, 1.5, 'abc', '', null, true, {}, Number.NaN])('falls back to defaults for invalid value %j', (value) => {
    expect(parsePagination({ page: value, limit: value })).toEqual({ page: 1, limit: DEFAULT_LIMIT, skip: 0, take: DEFAULT_LIMIT });
  });
});

describe('buildPaginationMeta', () => {
  it('describes a middle page', () => {
    expect(buildPaginationMeta(134, { page: 2, limit: 20 })).toEqual({
      page: 2, limit: 20, total: 134, totalPages: 7, hasNextPage: true, hasPrevPage: true,
    });
  });

  it('describes the first and last pages', () => {
    expect(buildPaginationMeta(40, { page: 1, limit: 20 })).toMatchObject({ totalPages: 2, hasNextPage: true, hasPrevPage: false });
    expect(buildPaginationMeta(40, { page: 2, limit: 20 })).toMatchObject({ totalPages: 2, hasNextPage: false, hasPrevPage: true });
  });

  it('reports zero pages for an empty result', () => {
    expect(buildPaginationMeta(0, { page: 1, limit: 20 })).toEqual({
      page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false,
    });
  });

  it('keeps hasPrevPage true for a page past the end', () => {
    expect(buildPaginationMeta(5, { page: 4, limit: 20 })).toMatchObject({ totalPages: 1, hasNextPage: false, hasPrevPage: true });
  });
});
