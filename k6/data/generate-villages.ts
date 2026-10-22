// Synthetic villages for k6 load tests. NOT part of prisma/seed.ts, by policy (docs/database.md):
// synthetic data lives only in this separate script, and every row it writes has a slug starting
// with "perf-", so k6/data/cleanup-villages.ts can remove exactly these rows and nothing else.
//
// Usage: npm run perf:data -- --count=20000 [--seed=1]
// The same --count and --seed always produce the same rows (ids included), so "before" and
// "after" measurements run against identical data.

import { createHash } from 'node:crypto';
import { PrismaClient, VillageNameType, type Prisma } from '@prisma/client';
import { assertLocalDatabase, PERF_SLUG_PREFIX } from './perf-guard.js';

const BATCH_SIZE = 1000;
const MAX_COUNT = 200_000;

// Prefix, root and suffix combine into ~1000 distinct names, so a search term matches a realistic
// number of villages (tens to thousands) instead of exactly one or all of them.
const PREFIXES = [
  { ar: 'بيت', en: 'Beit', alt: 'Bayt' },
  { ar: 'كفر', en: 'Kafr', alt: 'Kfar' },
  { ar: 'دير', en: 'Deir', alt: 'Dayr' },
  { ar: 'عين', en: 'Ein', alt: 'Ayn' },
  { ar: 'خربة', en: 'Khirbet', alt: 'Khirbat' },
  { ar: 'تل', en: 'Tell', alt: 'Tall' },
  { ar: 'برج', en: 'Burj', alt: 'Borj' },
  { ar: 'جبل', en: 'Jabal', alt: 'Jebel' },
  { ar: 'وادي', en: 'Wadi', alt: 'Wady' },
  { ar: 'عرب', en: 'Arab', alt: 'Aarab' },
] as const;

const ROOTS = [
  { ar: 'الزيتون', en: 'al-Zaytun' },
  { ar: 'الريحان', en: 'al-Rihan' },
  { ar: 'السنديان', en: 'al-Sindyan' },
  { ar: 'النخيل', en: 'al-Nakhil' },
  { ar: 'الجوز', en: 'al-Jawz' },
  { ar: 'التين', en: 'al-Tin' },
  { ar: 'الرمان', en: 'al-Rumman' },
  { ar: 'اللوز', en: 'al-Lawz' },
  { ar: 'الصفصاف', en: 'al-Safsaf' },
  { ar: 'البطم', en: 'al-Butm' },
  { ar: 'الخروب', en: 'al-Kharrub' },
  { ar: 'العنب', en: 'al-Inab' },
  { ar: 'الحمام', en: 'al-Hamam' },
  { ar: 'القمح', en: 'al-Qamh' },
  { ar: 'الشعير', en: 'al-Shair' },
  { ar: 'الورد', en: 'al-Ward' },
  { ar: 'الينابيع', en: 'al-Yanabi' },
  { ar: 'الحجر', en: 'al-Hajar' },
  { ar: 'الشمس', en: 'al-Shams' },
  { ar: 'القمر', en: 'al-Qamar' },
] as const;

const SUFFIXES = [
  { ar: '', en: '' },
  { ar: ' الشرقية', en: ' al-Sharqiya' },
  { ar: ' الغربية', en: ' al-Gharbiya' },
  { ar: ' الفوقا', en: ' al-Fauqa' },
  { ar: ' التحتا', en: ' al-Tahta' },
] as const;

// Share of villages that also get a former Arabic name, on top of the alternate English spelling.
const FORMER_NAME_RATE = 0.3;

function parseArgs(argv: string[]): { count: number; seed: number } {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
  const count = Number(value('count') ?? 20_000);
  const seed = Number(value('seed') ?? 1);

  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new Error(`--count must be an integer between 1 and ${MAX_COUNT}`);
  }
  if (!Number.isInteger(seed)) throw new Error('--seed must be an integer');

  return { count, seed };
}

// Small deterministic PRNG, so the data set depends only on --seed.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

// Version-4-shaped UUID derived from a string, so ids are stable across runs.
function deterministicUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function main(): Promise<void> {
  assertLocalDatabase();
  const { count, seed } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const existing = await prisma.village.count({ where: { slug: { startsWith: PERF_SLUG_PREFIX } } });
    if (existing > 0) {
      throw new Error(`${existing} ${PERF_SLUG_PREFIX}* villages already exist. Run "npm run perf:clean" first.`);
    }

    const governorates = await prisma.governorate.findMany({ select: { id: true }, orderBy: { code: 'asc' } });
    if (governorates.length === 0) throw new Error('No governorates found. Run "npm run db:seed" first.');

    const random = mulberry32(seed);
    let villagesWritten = 0;
    let namesWritten = 0;

    for (let start = 0; start < count; start += BATCH_SIZE) {
      const villages: Prisma.VillageCreateManyInput[] = [];
      const names: Prisma.VillageNameCreateManyInput[] = [];

      for (let i = start; i < Math.min(start + BATCH_SIZE, count); i += 1) {
        const slug = `${PERF_SLUG_PREFIX}${String(i + 1).padStart(6, '0')}`;
        const id = deterministicUuid(`perf-village:${seed}:${slug}`);
        const prefix = pick(random, PREFIXES);
        const root = pick(random, ROOTS);
        const suffix = pick(random, SUFFIXES);

        villages.push({
          id,
          slug,
          nameAr: `${prefix.ar} ${root.ar}${suffix.ar}`,
          nameEn: `${prefix.en} ${root.en}${suffix.en}`,
          // Spread evenly across governorates, so a governorate filter returns ~1/16 of the rows.
          governorateId: governorates[i % governorates.length]!.id,
          locationDescription: 'Synthetic load-test data (k6). Not a real place.',
        });

        // Spelled differently from nameEn, so searching for it can only match through village_names.
        names.push({
          id: deterministicUuid(`perf-name:${seed}:${slug}:alt`),
          villageId: id,
          name: `${prefix.alt} ${root.en}${suffix.en}`,
          language: 'en',
          nameType: VillageNameType.TRANSLITERATION,
        });

        if (random() < FORMER_NAME_RATE) {
          names.push({
            id: deterministicUuid(`perf-name:${seed}:${slug}:former`),
            villageId: id,
            name: `${pick(random, PREFIXES).ar} ${pick(random, ROOTS).ar}`,
            language: 'ar',
            nameType: VillageNameType.FORMER,
          });
        }
      }

      await prisma.$transaction([
        prisma.village.createMany({ data: villages }),
        prisma.villageName.createMany({ data: names }),
      ]);

      villagesWritten += villages.length;
      namesWritten += names.length;
      process.stdout.write(`\r${villagesWritten}/${count} villages, ${namesWritten} alternate names`);
    }

    process.stdout.write('\n');
    console.log(`Done: ${villagesWritten} synthetic villages and ${namesWritten} alternate names (seed ${seed}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
