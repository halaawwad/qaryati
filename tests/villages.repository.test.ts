import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  escapeLikePattern,
  villageRepository,
  type VillageListParams,
} from '../src/modules/villages/villages.repository.js';

// The tagged-template calls are recorded instead of run, so the SQL that findMany builds can be inspected.
const db = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  village: { count: vi.fn(), findMany: vi.fn() },
}));

vi.mock('../src/shared/db.js', () => ({
  prisma: {
    $queryRaw: db.queryRaw,
    $transaction: db.transaction,
    village: db.village,
  },
}));

interface RecordedQuery {
  strings: TemplateStringsArray;
  values: unknown[];
}

const flatten = (query: RecordedQuery) => {
  const sql = Prisma.sql(query.strings, ...query.values);
  // .text is the PostgreSQL form with $1, $2 placeholders.
  return { text: sql.text.replace(/\s+/g, ' ').trim(), values: sql.values };
};

const baseParams = (overrides: Partial<VillageListParams['filters']> = {}): VillageListParams => ({
  filters: { search: 'beit', ...overrides },
  sort: { field: 'nameAr', order: 'asc' },
  skip: 20,
  take: 10,
});

const row = (id: string) => ({
  id,
  slug: `slug-${id}`,
  nameAr: `ar-${id}`,
  nameEn: null,
  verificationStatus: 'PENDING',
  governorate: { id: 'g', nameAr: 'g', nameEn: null },
  localAuthority: null,
  latitude: null,
  longitude: null,
});

let recorded: RecordedQuery[];

beforeEach(() => {
  vi.resetAllMocks();
  recorded = [];
  db.queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { strings, values };
    recorded.push(query);
    return query;
  });
  db.transaction.mockResolvedValue([[{ total: 2n }], [{ id: 'b' }, { id: 'a' }]]);
  db.village.findMany.mockResolvedValue([row('a'), row('b')]);
});

describe('villageRepository.findMany with a search term', () => {
  it('finds ids with a UNION, so each side can use its trigram indexes', async () => {
    await villageRepository.findMany(baseParams());

    const [count, page] = recorded.map(flatten);
    for (const query of [count, page]) {
      expect(query?.text).toContain('UNION');
      expect(query?.text).toContain('v.name_ar ILIKE');
      expect(query?.text).toContain('v.name_en ILIKE');
      expect(query?.text).toContain('v.slug ILIKE');
      expect(query?.text).toContain('FROM village_names n JOIN villages v ON v.id = n.village_id');
      expect(query?.text).toContain('n.name ILIKE');
      expect(query?.text).toContain('n.deleted_at IS NULL');
      expect(query?.text).not.toMatch(/\bIN \(SELECT/);
    }
    expect(count?.text).toMatch(/^SELECT count\(\*\) AS total FROM \(/);
  });

  it('binds the escaped term as %term%: \, % and _ are matched literally', async () => {
    const cases: [string, string][] = [
      ['beit', '%beit%'],
      ['بيتا', '%بيتا%'],
      ['%', '%\\%%'],
      ['_', '%\\_%'],
      ['bei_', '%bei\\_%'],
      ['100%', '%100\\%%'],
      ['a\\b', '%a\\\\b%'],
      ['50%_\\', '%50\\%\\_\\\\%'],
    ];

    for (const [term, pattern] of cases) {
      recorded.length = 0;
      await villageRepository.findMany(baseParams({ search: term }));

      const queries = recorded.map(flatten);
      for (const query of queries) {
        expect(query.values).toContain(pattern);
        // Only a term with a special character changes; ordinary text keeps the same pattern as before.
        if (pattern !== `%${term}%`) expect(query.values).not.toContain(`%${term}%`);
      }
    }
  });

  it('uses plain ILIKE with the default escape: no ESCAPE clause, which would stop the trigram indexes being used', async () => {
    await villageRepository.findMany(baseParams());

    for (const query of recorded.map(flatten)) {
      // Four conditions in each of the count and the page query: name_ar, name_en, slug, and the alternate name.
      expect(query.text.match(/ILIKE \$\d+/g) ?? []).toHaveLength(4);
      expect(query.text).not.toMatch(/ESCAPE/i);
    }
  });

  it('never puts the term or a filter value into the SQL text', async () => {
    await villageRepository.findMany(
      baseParams({ search: "x'; DROP TABLE villages; --", governorateId: '11111111-1111-4111-8111-111111111111' }),
    );

    for (const query of recorded.map(flatten)) {
      expect(query.text).not.toContain('DROP TABLE');
      expect(query.text).not.toContain('11111111-1111');
    }
  });

  it('applies the filters to the village on both sides of the UNION, as bound and cast values', async () => {
    const governorateId = '11111111-1111-4111-8111-111111111111';
    const localAuthorityId = '22222222-2222-4222-8222-222222222222';
    await villageRepository.findMany(baseParams({ governorateId, localAuthorityId, verificationStatus: 'VERIFIED' }));

    const count = recorded.map(flatten)[0];
    expect(count?.text.match(/v\.governorate_id = \$\d+::uuid/g)).toHaveLength(2);
    expect(count?.text.match(/v\.local_authority_id = \$\d+::uuid/g)).toHaveLength(2);
    expect(count?.text.match(/v\.verification_status = \$\d+::"VerificationStatus"/g)).toHaveLength(2);
    expect(count?.text.match(/v\.deleted_at IS NULL/g)).toHaveLength(2);
    expect(count?.values).toEqual(expect.arrayContaining([governorateId, localAuthorityId, 'VERIFIED']));
  });

  it('orders by the sort column then id, with NULLS LAST only for the nullable columns', async () => {
    const cases: [VillageListParams['sort'], string][] = [
      [{ field: 'nameAr', order: 'asc' }, 'ORDER BY v.name_ar ASC , v.id ASC'],
      [{ field: 'nameEn', order: 'desc' }, 'ORDER BY v.name_en DESC NULLS LAST, v.id ASC'],
      [{ field: 'areaDunums', order: 'asc' }, 'ORDER BY v.area_dunums ASC NULLS LAST, v.id ASC'],
      [{ field: 'elevationM', order: 'desc' }, 'ORDER BY v.elevation_m DESC NULLS LAST, v.id ASC'],
      [{ field: 'createdAt', order: 'desc' }, 'ORDER BY v.created_at DESC , v.id ASC'],
    ];

    for (const [sort, expected] of cases) {
      recorded.length = 0;
      await villageRepository.findMany({ ...baseParams(), sort });

      expect(recorded.map(flatten)[1]?.text).toContain(expected);
    }
  });

  it('pages with LIMIT and OFFSET as bound values', async () => {
    await villageRepository.findMany(baseParams());

    const page = recorded.map(flatten)[1];
    expect(page?.text).toMatch(/LIMIT \$\d+ OFFSET \$\d+$/);
    expect(page?.values.slice(-2)).toEqual([10, 20]);
  });

  it('runs the count and the page in one transaction', async () => {
    await villageRepository.findMany(baseParams());

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.transaction.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('loads the page rows by id and returns them in the sorted order, with the total as a number', async () => {
    const result = await villageRepository.findMany(baseParams());

    expect(db.village.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['b', 'a'] } }, select: expect.any(Object) }),
    );
    expect(result.items.map((item) => item.id)).toEqual(['b', 'a']);
    expect(result.total).toBe(2);
    expect(result.items[0]).toMatchObject({ latitude: null, longitude: null });
  });

  it('skips the second query when nothing matches', async () => {
    db.transaction.mockResolvedValue([[{ total: 0n }], []]);

    await expect(villageRepository.findMany(baseParams())).resolves.toEqual({ items: [], total: 0 });
    expect(db.village.findMany).not.toHaveBeenCalled();
  });

  it('drops an id whose row disappeared between the two queries instead of failing', async () => {
    db.village.findMany.mockResolvedValue([row('a')]);

    const result = await villageRepository.findMany(baseParams());

    expect(result.items.map((item) => item.id)).toEqual(['a']);
  });
});

describe('villageRepository.findMany without a search term', () => {
  it('keeps using Prisma count and findMany, with no raw SQL', async () => {
    db.transaction.mockResolvedValue([1, [row('a')]]);

    const result = await villageRepository.findMany({
      filters: { governorateId: '11111111-1111-4111-8111-111111111111' },
      sort: { field: 'nameAr', order: 'asc' },
      skip: 0,
      take: 20,
    });

    expect(db.queryRaw).not.toHaveBeenCalled();
    expect(db.village.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ deletedAt: null, governorateId: '11111111-1111-4111-8111-111111111111' }),
    });
    expect(result).toMatchObject({ total: 1, items: [{ id: 'a' }] });
  });
});

describe('escapeLikePattern', () => {
  it('puts a backslash in front of each backslash, percent sign and underscore', () => {
    expect(escapeLikePattern('%')).toBe('\\%');
    expect(escapeLikePattern('_')).toBe('\\_');
    expect(escapeLikePattern('\\')).toBe('\\\\');
    expect(escapeLikePattern('bei_')).toBe('bei\\_');
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('does not escape an escape twice', () => {
    expect(escapeLikePattern('%_')).toBe('\\%\\_');
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%');
  });

  it('leaves ordinary text alone, Arabic and English, and the empty string', () => {
    for (const text of ['beit', 'Beit Iba', 'بيت', 'كفر الرمان', 'al-sharqiya', 'zaytun', '']) {
      expect(escapeLikePattern(text)).toBe(text);
    }
  });
});
