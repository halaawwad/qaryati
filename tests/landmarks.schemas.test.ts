import { LandmarkType, VerificationStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  createLandmarkSchema,
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

describe('createLandmarkSchema', () => {
  const requiredFields = {
    nameAr: 'عين البلد',
    landmarkType: LandmarkType.SPRING,
    sourceId: id,
  };

  it('accepts only the required fields and trims the Arabic name', () => {
    expect(createLandmarkSchema.parse({ ...requiredFields, nameAr: '  عين البلد  ' })).toEqual(requiredFields);
  });

  it('accepts all optional fields and trims text', () => {
    expect(createLandmarkSchema.parse({
      ...requiredFields,
      nameEn: '  Village Spring  ',
      description: '  A documented spring.  ',
      latitude: 32.123456,
      longitude: 35.654321,
    })).toEqual({
      ...requiredFields,
      nameEn: 'Village Spring',
      description: 'A documented spring.',
      latitude: 32.123456,
      longitude: 35.654321,
    });
  });

  it.each([undefined, '', '   '])('rejects a missing or blank Arabic name: %j', (nameAr) => {
    const result = createLandmarkSchema.safeParse({ ...requiredFields, nameAr });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['nameAr']);
  });

  it.each([undefined, 'UNKNOWN'])('rejects a missing or invalid landmark type: %j', (landmarkType) => {
    const result = createLandmarkSchema.safeParse({ ...requiredFields, landmarkType });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['landmarkType']);
  });

  it.each([undefined, null, '', 'not-a-uuid'])('requires a valid source UUID: %j', (sourceId) => {
    const result = createLandmarkSchema.safeParse({ ...requiredFields, sourceId });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['sourceId']);
  });

  it.each([
    { latitude: -90, longitude: -180 },
    { latitude: 90, longitude: 180 },
    { latitude: 0, longitude: 0 },
  ])('accepts inclusive coordinate boundaries and zero: %j', (coordinates) => {
    const input = { ...requiredFields, ...coordinates };
    expect(createLandmarkSchema.parse(input)).toEqual(input);
  });

  it.each([
    { latitude: -90.000001, longitude: 0 },
    { latitude: 90.000001, longitude: 0 },
    { latitude: 0, longitude: -180.000001 },
    { latitude: 0, longitude: 180.000001 },
    { latitude: '32.1', longitude: 35.2 },
    { latitude: 32.1, longitude: '35.2' },
  ])('rejects out-of-range or nonnumeric coordinates: %j', (coordinates) => {
    expect(createLandmarkSchema.safeParse({ ...requiredFields, ...coordinates }).success).toBe(false);
  });

  it.each([
    {},
    { latitude: null, longitude: null },
    { latitude: null },
    { longitude: null },
  ])('accepts coordinates when neither contains a number: %j', (coordinates) => {
    const input = { ...requiredFields, ...coordinates };
    expect(createLandmarkSchema.parse(input)).toEqual(input);
  });

  it.each([
    { coordinates: { latitude: 0 }, missing: 'longitude' },
    { coordinates: { longitude: 0 }, missing: 'latitude' },
    { coordinates: { latitude: 32.1, longitude: null }, missing: 'longitude' },
    { coordinates: { latitude: null, longitude: 35.2 }, missing: 'latitude' },
  ])('rejects a partial coordinate pair: $coordinates', ({ coordinates, missing }) => {
    const result = createLandmarkSchema.safeParse({ ...requiredFields, ...coordinates });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: 'custom', path: [missing] }),
    ]);
  });

  it.each([
    ['verificationStatus', VerificationStatus.VERIFIED],
    ['version', 2],
    ['createdById', id],
    ['deletedAt', null],
    ['villageId', id],
    ['unexpected', 'value'],
  ])('rejects the unexpected body property %s', (field, value) => {
    const result = createLandmarkSchema.safeParse({ ...requiredFields, [field as string]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: 'unrecognized_keys', keys: [field] }),
    ]);
  });

  it.each(['', '   '])('rejects a blank optional English name: %j', (nameEn) => {
    const result = createLandmarkSchema.safeParse({ ...requiredFields, nameEn });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['nameEn']);
  });

  it('allows an empty description after trimming', () => {
    expect(createLandmarkSchema.parse({ ...requiredFields, description: '   ' }).description).toBe('');
  });

  it('accepts maximum string lengths after trimming', () => {
    const fields = { nameAr: 'ع'.repeat(200), nameEn: 'a'.repeat(200), description: 'd'.repeat(5000) };
    expect(createLandmarkSchema.parse({
      ...requiredFields,
      nameAr: ` ${fields.nameAr} `,
      nameEn: ` ${fields.nameEn} `,
      description: ` ${fields.description} `,
    })).toEqual({ ...requiredFields, ...fields });
  });

  it.each([
    { field: 'nameAr', value: 'ع'.repeat(201) },
    { field: 'nameEn', value: 'a'.repeat(201) },
    { field: 'description', value: 'd'.repeat(5001) },
  ])('rejects an excessively long $field', ({ field, value }) => {
    const result = createLandmarkSchema.safeParse({ ...requiredFields, [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([field]);
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
