// Removes the synthetic villages created by generate-villages.ts, and nothing else: only rows whose
// slug starts with "perf-", together with their alternate names and nearby places.
// Any other table still pointing at a perf- village (population, landmarks, ...) makes the delete fail
// on its foreign key instead of silently removing data this script didn't create.
//
// Usage: npm run perf:clean

import { PrismaClient } from '@prisma/client';
import { assertLocalDatabase, PERF_SLUG_PREFIX } from './perf-guard.js';

async function main(): Promise<void> {
  assertLocalDatabase();
  const prisma = new PrismaClient();

  try {
    const perfVillage = { slug: { startsWith: PERF_SLUG_PREFIX } };

    const [names, nearby, villages] = await prisma.$transaction([
      prisma.villageName.deleteMany({ where: { village: perfVillage } }),
      prisma.nearbyPlace.deleteMany({
        where: { OR: [{ village: perfVillage }, { relatedVillage: perfVillage }] },
      }),
      prisma.village.deleteMany({ where: perfVillage }),
    ]);

    const remaining = await prisma.village.count();
    console.log(
      `Deleted ${villages.count} ${PERF_SLUG_PREFIX}* villages, ${names.count} alternate names, ` +
        `${nearby.count} nearby places. Villages left: ${remaining}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
