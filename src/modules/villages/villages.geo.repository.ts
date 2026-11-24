import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/db.js';

const select = {
  id: true, nameAr: true, nameEn: true, latitude: true, longitude: true,
  geoDisplayName: true, geoEnrichedAt: true, verificationStatus: true, version: true,
  updatedAt: true, governorate: { select: { nameAr: true, nameEn: true } },
} satisfies Prisma.VillageSelect;
type Row = Prisma.VillageGetPayload<{ select: typeof select }>;
const toGeo = (row: Row) => ({ ...row, latitude: row.latitude?.toNumber() ?? null, longitude: row.longitude?.toNumber() ?? null });
export type VillageGeo = ReturnType<typeof toGeo>;
export interface GeoUpdate {
  latitude: number; longitude: number; geoDisplayName: string; geoEnrichedAt: Date; actorId: string;
}
export interface VillageGeoRepository {
  transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  find(id: string, tx?: Prisma.TransactionClient): Promise<VillageGeo | null>;
  lock(id: string, tx: Prisma.TransactionClient): Promise<void>;
  apply(id: string, version: number, update: GeoUpdate, tx: Prisma.TransactionClient): Promise<VillageGeo | null>;
}
export const villageGeoRepository: VillageGeoRepository = {
  transaction(fn) { return prisma.$transaction(fn); },
  async find(id, tx = prisma) {
    const row = await tx.village.findFirst({ where: { id, deletedAt: null }, select });
    return row ? toGeo(row) : null;
  },
  async lock(id, tx) {
    await tx.$queryRaw`SELECT id FROM villages WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
  },
  async apply(id, version, update, tx) {
    const { actorId, ...geo } = update;
    const result = await tx.village.updateMany({
      where: { id, version, deletedAt: null },
      data: { ...geo, updatedById: actorId, version: { increment: 1 } },
    });
    if (result.count !== 1) return null;
    const row = await tx.village.findFirst({ where: { id, deletedAt: null }, select });
    return row ? toGeo(row) : null;
  },
};
