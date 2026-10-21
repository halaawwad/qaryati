import { describe, expect, it } from 'vitest';
import { listVillagesQuerySchema, nearbyVillagesQuerySchema } from '../src/modules/villages/villages.schemas.js';
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
