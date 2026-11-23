// Removes the synthetic villages created by generate-villages.ts, and nothing else: only rows whose
// slug starts with "perf-", together with their alternate names, nearby places and the audit rows
// the write load test (k6/village-writes.js) leaves behind for them.
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

    // audit_logs.entity_id is a plain string, not a foreign key, so it is matched through a subquery.
    // Only rows about perf- villages (entity_type 'village') are removed.
    const likePrefix = `${PERF_SLUG_PREFIX}%`;

    const [audit, names, nearby, villages] = await prisma.$transaction([
      prisma.$executeRaw`
        DELETE FROM audit_logs
        WHERE entity_type = 'village'
          AND entity_id IN (SELECT id::text FROM villages WHERE slug LIKE ${likePrefix})
      `,
      prisma.villageName.deleteMany({ where: { village: perfVillage } }),
      prisma.nearbyPlace.deleteMany({
        where: { OR: [{ village: perfVillage }, { relatedVillage: perfVillage }] },
      }),
      prisma.village.deleteMany({ where: perfVillage }),
    ]);

    const remaining = await prisma.village.count();
    console.log(
      `Deleted ${villages.count} ${PERF_SLUG_PREFIX}* villages, ${names.count} alternate names, ` +
        `${nearby.count} nearby places, ${audit} audit rows. Villages left: ${remaining}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
