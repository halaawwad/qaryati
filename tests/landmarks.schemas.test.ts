import { LandmarkType, VerificationStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  landmarkParamsSchema,
  listLandmarksQuerySchema,
  villageLandmarksParamsSchema,
} from '../src/modules/landmarks/landmarks.schemas.js';
import { parsePagination } from '../src/shared/pagination.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('landmark params schemas', () => {
  it('accepts UUID village and landmark identifiers', () => {
    expect(villageLandmarksParamsSchema.parse({ villageId: id })).toEqual({ villageId: id });
    expect(landmarkParamsSchema.parse({ id })).toEqual({ id });
  });

  it('rejects missing identifiers and slugs', () => {
    expect(villageLandmarksParamsSchema.safeParse({}).success).toBe(false);
    expect(villageLandmarksParamsSchema.safeParse({ villageId: 'beita' }).success).toBe(false);
    expect(landmarkParamsSchema.safeParse({}).success).toBe(false);
    expect(landmarkParamsSchema.safeParse({ id: 'old-mosque' }).success).toBe(false);
  });
});

describe('listLandmarksQuerySchema', () => {
  it('keeps all filters optional without imposing a verification status', () => {
    expect(listLandmarksQuerySchema.parse({})).toEqual({});
  });

  it('coerces pagination and trims Arabic search text', () => {
    expect(listLandmarksQuerySchema.parse({ page: '2', limit: '5', search: '  عين البلد  ' })).toEqual({
      page: 2,
      limit: 5,
      search: 'عين البلد',
    });
  });

  it('treats blank search as absent', () => {
    expect(listLandmarksQuerySchema.parse({ search: '   ' }).search).toBeUndefined();
  });

  it('accepts filters and sorting', () => {
    const query = {
      landmarkType: LandmarkType.SPRING,
      verificationStatus: VerificationStatus.REJECTED,
      sort: 'nameEn',
      order: 'desc',
    };
    expect(listLandmarksQuerySchema.parse(query)).toEqual(query);
  });

  it('accepts large limits for shared pagination to cap', () => {
    const query = listLandmarksQuerySchema.parse({ limit: '500' });
    expect(query.limit).toBe(500);
    expect(parsePagination(query).limit).toBe(100);
  });

  it.each([
    { page: '0' },
    { page: '-1' },
    { page: '1.5' },
    { page: 'abc' },
    { limit: '0' },
    { limit: '-1' },
    { limit: '1.5' },
    { limit: 'abc' },
    { search: 'x'.repeat(101) },
    { search: ['spring', 'mosque'] },
    { landmarkType: 'UNKNOWN' },
    { verificationStatus: 'UNKNOWN' },
    { sort: 'description' },
    { order: 'sideways' },
  ])('rejects invalid query %j', (query) => {
    expect(listLandmarksQuerySchema.safeParse(query).success).toBe(false);
  });
});
