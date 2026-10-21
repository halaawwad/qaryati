import { describe, expect, it } from 'vitest';
import {
  createNearbyPlaceBodySchema,
  createVillageBodySchema,
  createVillageNameBodySchema,
  listVillagesQuerySchema,
  nearbyVillagesQuerySchema,
  updateVillageBodySchema,
  updateVillageNameBodySchema,
} from '../src/modules/villages/villages.schemas.js';
import { parsePagination } from '../src/shared/pagination.js';

describe('listVillagesQuerySchema', () => {
  it('rejects an unknown sort field', () => {
    const result = listVillagesQuerySchema.safeParse({ sort: 'population' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['sort']);
  });

  it('accepts a limit above 100, which parsePagination then caps', () => {
    const result = listVillagesQuerySchema.safeParse({ limit: '500' });

    expect(result.success).toBe(true);
    expect(result.data?.limit).toBe(500);
    expect(parsePagination(result.data ?? {}).limit).toBe(100);
  });

  it('rejects a governorateId that is not a uuid', () => {
    const result = listVillagesQuerySchema.safeParse({ governorateId: 'nablus' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['governorateId']);
  });

  it('coerces numeric strings and treats an empty search as absent', () => {
    const result = listVillagesQuerySchema.safeParse({ page: '2', limit: '5', search: '   ' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ page: 2, limit: 5, search: undefined });
  });
});

describe('nearbyVillagesQuerySchema', () => {
  it.each(['-1', '0', '51', 'abc'])('rejects radiusKm=%s', (radiusKm) => {
    const result = nearbyVillagesQuerySchema.safeParse({ radiusKm });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['radiusKm']);
  });

  it('coerces a valid radiusKm and allows it to be omitted', () => {
    expect(nearbyVillagesQuerySchema.parse({ radiusKm: '2.5' })).toEqual({ radiusKm: 2.5 });
    expect(nearbyVillagesQuerySchema.parse({})).toEqual({});
  });
});

describe('village write schemas', () => {
  const valid = {
    slug: 'test-village',
    nameAr: 'قرية اختبار',
    governorateId: '11111111-1111-4111-8111-111111111111',
  };

  it.each(['Test-Village', 'test village', 'قرية', 'test--village', '-test'])('rejects slug %j', (slug) => {
    const result = createVillageBodySchema.safeParse({ ...valid, slug });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['slug']);
  });

  it('requires latitude and longitude together, within range', () => {
    expect(createVillageBodySchema.safeParse({ ...valid, latitude: 32.1 }).success).toBe(false);
    expect(createVillageBodySchema.safeParse({ ...valid, latitude: 32.1, longitude: null }).success).toBe(false);
    expect(createVillageBodySchema.safeParse({ ...valid, latitude: 91, longitude: 35 }).success).toBe(false);
    expect(createVillageBodySchema.safeParse({ ...valid, latitude: 32.1, longitude: 35.2 }).success).toBe(true);
    expect(createVillageBodySchema.safeParse({ ...valid, latitude: null, longitude: null }).success).toBe(true);
  });

  it.each(['id', 'verificationStatus', 'createdById', 'updatedById', 'deletedAt', 'geoDisplayName', 'geoEnrichedAt', 'version'])(
    'rejects server-owned field %s on create',
    (field) => {
      expect(createVillageBodySchema.safeParse({ ...valid, [field]: 'x' }).success).toBe(false);
    },
  );

  it('requires version and at least one change on update', () => {
    expect(updateVillageBodySchema.safeParse({ nameEn: 'X' }).success).toBe(false);
    expect(updateVillageBodySchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateVillageBodySchema.safeParse({ version: 1, verificationStatus: 'VERIFIED' }).success).toBe(false);
    expect(updateVillageBodySchema.parse({ version: 1, nameEn: 'X' })).toEqual({ version: 1, nameEn: 'X' });
  });
});

describe('village name schemas', () => {
  const valid = { name: 'Bayta', language: 'en', nameType: 'TRANSLITERATION' };

  it('accepts ar and en only', () => {
    expect(createVillageNameBodySchema.safeParse(valid).success).toBe(true);
    expect(createVillageNameBodySchema.safeParse({ ...valid, language: 'ar' }).success).toBe(true);
    expect(createVillageNameBodySchema.safeParse({ ...valid, language: 'fr' }).success).toBe(false);
  });

  it('rejects periodFrom after periodTo, and accepts open-ended periods', () => {
    expect(createVillageNameBodySchema.safeParse({ ...valid, periodFrom: 1950, periodTo: 1900 }).success).toBe(false);
    expect(createVillageNameBodySchema.safeParse({ ...valid, periodFrom: 1900, periodTo: 1900 }).success).toBe(true);
    expect(createVillageNameBodySchema.safeParse({ ...valid, periodFrom: 1900 }).success).toBe(true);
  });

  it.each(['id', 'villageId', 'verificationStatus', 'createdById', 'deletedAt', 'version'])(
    'rejects server-owned field %s on create',
    (field) => {
      expect(createVillageNameBodySchema.safeParse({ ...valid, [field]: 'x' }).success).toBe(false);
    },
  );

  it('requires version and at least one change on update', () => {
    expect(updateVillageNameBodySchema.safeParse({ name: 'X' }).success).toBe(false);
    expect(updateVillageNameBodySchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateVillageNameBodySchema.safeParse({ version: 1, periodTo: 1900 }).success).toBe(true);
  });
});

describe('nearby place schema', () => {
  const villageId = '22222222-2222-4222-8222-222222222222';

  it('accepts a related village or an external place', () => {
    expect(createNearbyPlaceBodySchema.safeParse({ relatedVillageId: villageId, relation: 'ADJACENT' }).success).toBe(true);
    expect(
      createNearbyPlaceBodySchema.safeParse({ placeName: 'نابلس', placeType: 'CITY', relation: 'NEARBY', distanceKm: 12.5 }).success,
    ).toBe(true);
  });

  it('rejects a body that mixes both shapes or misses fields', () => {
    expect(
      createNearbyPlaceBodySchema.safeParse({ relatedVillageId: villageId, placeName: 'x', placeType: 'CITY', relation: 'NEARBY' })
        .success,
    ).toBe(false);
    expect(createNearbyPlaceBodySchema.safeParse({ placeName: 'x', relation: 'NEARBY' }).success).toBe(false);
    expect(createNearbyPlaceBodySchema.safeParse({ relatedVillageId: 'beita', relation: 'NEARBY' }).success).toBe(false);
  });

  it.each([0, -1])('rejects distanceKm=%s', (distanceKm) => {
    expect(createNearbyPlaceBodySchema.safeParse({ relatedVillageId: villageId, relation: 'NEARBY', distanceKm }).success).toBe(
      false,
    );
  });
});
