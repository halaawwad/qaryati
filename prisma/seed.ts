import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import bcrypt from 'bcryptjs';
import {
  EconomicCategory,
  FacilityType,
  HeritageCategory,
  LandmarkType,
  LocalAuthorityType,
  PrismaClient,
  Role,
  SourceType,
  VillageNameType,
} from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

const adminId = '00000000-0000-4000-8000-000000000001';

const governorates = [
  ['01000000-0000-4000-8000-000000000001', 'جنين', 'Jenin', 'JEN'],
  ['01000000-0000-4000-8000-000000000002', 'طوباس والأغوار الشمالية', 'Tubas and Northern Valleys', 'TUB'],
  ['01000000-0000-4000-8000-000000000003', 'طولكرم', 'Tulkarm', 'TLK'],
  ['01000000-0000-4000-8000-000000000004', 'نابلس', 'Nablus', 'NAB'],
  ['01000000-0000-4000-8000-000000000005', 'قلقيلية', 'Qalqilya', 'QAL'],
  ['01000000-0000-4000-8000-000000000006', 'سلفيت', 'Salfit', 'SAL'],
  ['01000000-0000-4000-8000-000000000007', 'رام الله والبيرة', 'Ramallah and Al-Bireh', 'RAB'],
  ['01000000-0000-4000-8000-000000000008', 'أريحا والأغوار', 'Jericho and Al Aghwar', 'JER'],
  ['01000000-0000-4000-8000-000000000009', 'القدس', 'Jerusalem', 'JRS'],
  ['01000000-0000-4000-8000-000000000010', 'بيت لحم', 'Bethlehem', 'BTH'],
  ['01000000-0000-4000-8000-000000000011', 'الخليل', 'Hebron', 'HEB'],
  ['01000000-0000-4000-8000-000000000012', 'شمال غزة', 'North Gaza', 'NGZ'],
  ['01000000-0000-4000-8000-000000000013', 'غزة', 'Gaza', 'GZA'],
  ['01000000-0000-4000-8000-000000000014', 'دير البلح', 'Deir al-Balah', 'DBL'],
  ['01000000-0000-4000-8000-000000000015', 'خان يونس', 'Khan Yunis', 'KYN'],
  ['01000000-0000-4000-8000-000000000016', 'رفح', 'Rafah', 'RFH'],
] as const;

const sourceRefSchema = z.string().min(1);

const sourceSchema = z.object({
  id: sourceRefSchema,
  organization: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  sourceType: z.nativeEnum(SourceType),
  year: z.number().int(),
});

const populationRecordSchema = z.object({
  referenceYear: z.number().int(),
  population: z.number().int().positive(),
  isEstimate: z.boolean(),
  isPreferred: z.boolean(),
  estimateType: z.string().nullable(),
  sourceId: sourceRefSchema,
});

const localAuthoritySchema = z.object({
  nameAr: z.string().min(1),
  nameEn: z.string().nullable(),
  type: z.nativeEnum(LocalAuthorityType),
  asOfYear: z.number().int().nullable(),
  sourceId: sourceRefSchema,
});

const coordinatesSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  note: z.string().nullable().optional(),
});

const landmarkSchema = z.object({
  nameAr: z.string().min(1),
  nameEn: z.string().nullable(),
  landmarkType: z.nativeEnum(LandmarkType),
  description: z.string().nullable(),
  sourceId: sourceRefSchema,
});

const heritageItemSchema = z.object({
  category: z.nativeEnum(HeritageCategory),
  name: z.string().min(1),
  description: z.string().nullable(),
  sourceId: sourceRefSchema,
});

const economicActivitySchema = z.object({
  category: z.nativeEnum(EconomicCategory),
  name: z.string().min(1),
  description: z.string().nullable(),
  asOfYear: z.number().int().nullable(),
  sourceId: sourceRefSchema,
});

const facilitySchema = z.object({
  facilityType: z.nativeEnum(FacilityType),
  name: z.string().min(1),
  description: z.string().nullable(),
  asOfYear: z.number().int().nullable(),
  sourceId: sourceRefSchema,
});

const historicalEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable(),
  eventYear: z.number().int().nullable(),
  isApproximate: z.boolean(),
  category: z.string().nullable(),
  sourceId: sourceRefSchema,
});

const villageNameSchema = z.object({
  name: z.string().min(1),
  language: z.string().min(1),
  nameType: z.nativeEnum(VillageNameType),
  sourceId: sourceRefSchema,
});

const villageSchema = z.object({
  slug: z.string().min(1),
  nameAr: z.string().min(1),
  nameEn: z.string().nullable(),
  governorate: z.string().min(1),
  pcbsLocalityCode: z.string().nullable(),
  localAuthority: localAuthoritySchema.nullable(),
  coordinates: coordinatesSchema.nullable(),
  elevationM: z.number().int().nullable(),
  areaDunums: z.number().nullable(),
  locationDescription: z.string().nullable(),
  nameOrigin: z.string().nullable(),
  historicalOverview: z.string().nullable(),
  populationRecords: z.array(populationRecordSchema),
  landmarks: z.array(landmarkSchema),
  heritageItems: z.array(heritageItemSchema),
  economicActivities: z.array(economicActivitySchema),
  facilities: z.array(facilitySchema),
  historicalEvents: z.array(historicalEventSchema),
  villageNames: z.array(villageNameSchema),
  nearbyPlaces: z.array(z.unknown()),
  sourceIds: z.array(sourceRefSchema).optional(),
  nameOriginSourceId: sourceRefSchema.nullable().optional(),
});

const localitiesSchema = z.object({
  dataset: z.string(),
  version: z.string(),
  generatedAt: z.string().optional(),
  policy: z.unknown().optional(),
  sources: z.array(sourceSchema),
  villages: z.array(villageSchema),
  verificationNotes: z.unknown().optional(),
});

type LocalitiesData = z.infer<typeof localitiesSchema>;

function deterministicUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function childId(villageSlug: string, table: string, itemName: string): string {
  return deterministicUuid(`${villageSlug}|${table}|${itemName}`);
}

function loadLocalities(): LocalitiesData {
  const seedDir = dirname(fileURLToPath(import.meta.url));
  const filePath = join(seedDir, 'data', 'localities.json');
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  const parsed = localitiesSchema.safeParse(raw);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');

    throw new Error(`Invalid prisma/data/localities.json structure: ${details}`);
  }

  return parsed.data;
}

function resolveSource(sourceIdsByJsonId: Map<string, string>, jsonSourceId: string, context: string): string {
  const sourceId = sourceIdsByJsonId.get(jsonSourceId);
  if (!sourceId) {
    throw new Error(`Unknown sourceId "${jsonSourceId}" at ${context}.`);
  }

  return sourceId;
}

async function seedAdmin(): Promise<void> {
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required.');
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  await prisma.user.upsert({
    where: { id: adminId },
    update: {
      email: adminEmail,
      passwordHash,
      fullName: 'Seed Admin',
      role: Role.ADMIN,
      isActive: true,
    },
    create: {
      id: adminId,
      email: adminEmail,
      passwordHash,
      fullName: 'Seed Admin',
      role: Role.ADMIN,
      isActive: true,
    },
  });
}

async function seedGovernorates(): Promise<Map<string, string>> {
  const idsByArabicName = new Map<string, string>();

  for (const [id, nameAr, nameEn, code] of governorates) {
    idsByArabicName.set(nameAr, id);

    await prisma.governorate.upsert({
      where: { id },
      update: { nameAr, nameEn, code },
      create: { id, nameAr, nameEn, code },
    });
  }

  return idsByArabicName;
}

async function seedSources(data: LocalitiesData): Promise<Map<string, string>> {
  const idsByJsonId = new Map<string, string>();

  for (const source of data.sources) {
    const id = deterministicUuid(`source:${source.id}`);
    idsByJsonId.set(source.id, id);

    await prisma.source.upsert({
      where: { id },
      update: {
        title: source.title,
        publisher: source.organization,
        url: source.url,
        year: source.year,
        sourceType: SourceType.GOVERNMENT,
      },
      create: {
        id,
        title: source.title,
        publisher: source.organization,
        url: source.url,
        year: source.year,
        sourceType: SourceType.GOVERNMENT,
      },
    });
  }

  return idsByJsonId;
}

async function upsertLocalAuthority(
  locality: LocalitiesData['villages'][number],
  governorateId: string,
  sourceIdsByJsonId: Map<string, string>,
): Promise<string | null> {
  if (!locality.localAuthority) {
    return null;
  }

  const authority = locality.localAuthority;
  const sourceId = resolveSource(sourceIdsByJsonId, authority.sourceId, `${locality.slug}.localAuthority.sourceId`);

  const localAuthority = await prisma.localAuthority.upsert({
    where: {
      governorateId_nameAr: {
        governorateId,
        nameAr: authority.nameAr,
      },
    },
    update: {
      nameEn: authority.nameEn,
      type: authority.type,
      asOfYear: authority.asOfYear,
      sourceId,
    },
    create: {
      governorateId,
      nameAr: authority.nameAr,
      nameEn: authority.nameEn,
      type: authority.type,
      asOfYear: authority.asOfYear,
      sourceId,
    },
  });

  return localAuthority.id;
}

async function seedVillageChildren(
  locality: LocalitiesData['villages'][number],
  villageId: string,
  sourceIdsByJsonId: Map<string, string>,
): Promise<void> {
  for (const populationRecord of locality.populationRecords) {
    const sourceId = resolveSource(sourceIdsByJsonId, populationRecord.sourceId, `${locality.slug}.populationRecords.sourceId`);

    await prisma.populationRecord.upsert({
      where: {
        villageId_referenceYear_sourceId: {
          villageId,
          referenceYear: populationRecord.referenceYear,
          sourceId,
        },
      },
      update: {
        population: populationRecord.population,
        isEstimate: populationRecord.isEstimate,
        isPreferred: populationRecord.isPreferred,
        notes: populationRecord.estimateType,
      },
      create: {
        villageId,
        population: populationRecord.population,
        referenceYear: populationRecord.referenceYear,
        sourceId,
        isEstimate: populationRecord.isEstimate,
        isPreferred: populationRecord.isPreferred,
        notes: populationRecord.estimateType,
      },
    });
  }

  for (const item of locality.villageNames) {
    const sourceId = resolveSource(sourceIdsByJsonId, item.sourceId, `${locality.slug}.villageNames.${item.name}.sourceId`);

    await prisma.villageName.upsert({
      where: { id: childId(locality.slug, 'village_names', item.name) },
      update: {
        villageId,
        name: item.name,
        language: item.language,
        nameType: item.nameType,
        sourceId,
      },
      create: {
        id: childId(locality.slug, 'village_names', item.name),
        villageId,
        name: item.name,
        language: item.language,
        nameType: item.nameType,
        sourceId,
      },
    });
  }

  for (const item of locality.landmarks) {
    const sourceId = resolveSource(sourceIdsByJsonId, item.sourceId, `${locality.slug}.landmarks.${item.nameAr}.sourceId`);

    await prisma.landmark.upsert({
      where: { id: childId(locality.slug, 'landmarks', item.nameAr) },
      update: {
        villageId,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        landmarkType: item.landmarkType,
        description: item.description,
        sourceId,
      },
      create: {
        id: childId(locality.slug, 'landmarks', item.nameAr),
        villageId,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        landmarkType: item.landmarkType,
        description: item.description,
        sourceId,
      },
    });
  }

  for (const item of locality.heritageItems) {
    const sourceId = resolveSource(sourceIdsByJsonId, item.sourceId, `${locality.slug}.heritageItems.${item.name}.sourceId`);

    await prisma.heritageItem.upsert({
      where: { id: childId(locality.slug, 'heritage_items', item.name) },
      update: {
        villageId,
        category: item.category,
        name: item.name,
        description: item.description,
        sourceId,
      },
      create: {
        id: childId(locality.slug, 'heritage_items', item.name),
        villageId,
        category: item.category,
        name: item.name,
        description: item.description,
        sourceId,
      },
    });
  }

  for (const item of locality.economicActivities) {
    const sourceId = resolveSource(sourceIdsByJsonId, item.sourceId, `${locality.slug}.economicActivities.${item.name}.sourceId`);

    await prisma.economicActivity.upsert({
      where: { id: childId(locality.slug, 'economic_activities', item.name) },
      update: {
        villageId,
        category: item.category,
        name: item.name,
        description: item.description,
        asOfYear: item.asOfYear,
        sourceId,
      },
      create: {
        id: childId(locality.slug, 'economic_activities', item.name),
        villageId,
        category: item.category,
        name: item.name,
        description: item.description,
        asOfYear: item.asOfYear,
        sourceId,
      },
    });
  }

  for (const item of locality.facilities) {
    const sourceId = resolveSource(sourceIdsByJsonId, item.sourceId, `${locality.slug}.facilities.${item.name}.sourceId`);

    await prisma.facility.upsert({
      where: { id: childId(locality.slug, 'facilities', item.name) },
      update: {
        villageId,
        facilityType: item.facilityType,
        name: item.name,
        description: item.description,
        asOfYear: item.asOfYear,
        sourceId,
      },
      create: {
        id: childId(locality.slug, 'facilities', item.name),
        villageId,
        facilityType: item.facilityType,
        name: item.name,
        description: item.description,
        asOfYear: item.asOfYear,
        sourceId,
      },
    });
  }

  for (const item of locality.historicalEvents) {
    const sourceId = resolveSource(sourceIdsByJsonId, item.sourceId, `${locality.slug}.historicalEvents.${item.title}.sourceId`);

    await prisma.historicalEvent.upsert({
      where: { id: childId(locality.slug, 'historical_events', item.title) },
      update: {
        villageId,
        title: item.title,
        description: item.description,
        eventYear: item.eventYear,
        isApproximate: item.isApproximate,
        category: item.category,
        sourceId,
      },
      create: {
        id: childId(locality.slug, 'historical_events', item.title),
        villageId,
        title: item.title,
        description: item.description,
        eventYear: item.eventYear,
        isApproximate: item.isApproximate,
        category: item.category,
        sourceId,
      },
    });
  }
}

async function seedVillages(
  data: LocalitiesData,
  governorateIdsByArabicName: Map<string, string>,
  sourceIdsByJsonId: Map<string, string>,
): Promise<void> {
  for (const locality of data.villages) {
    const governorateId = governorateIdsByArabicName.get(locality.governorate);
    if (!governorateId) {
      throw new Error(`Unknown governorate "${locality.governorate}" at villages.${locality.slug}.governorate.`);
    }

    const localAuthorityId = await upsertLocalAuthority(locality, governorateId, sourceIdsByJsonId);
    const nameOriginSourceId = locality.nameOriginSourceId
      ? resolveSource(sourceIdsByJsonId, locality.nameOriginSourceId, `${locality.slug}.nameOriginSourceId`)
      : null;

    const village = await prisma.village.upsert({
      where: { slug: locality.slug },
      update: {
        nameAr: locality.nameAr,
        nameEn: locality.nameEn,
        pcbsCode: locality.pcbsLocalityCode,
        governorateId,
        localAuthorityId,
        nameOrigin: locality.nameOrigin,
        nameOriginSourceId,
        latitude: locality.coordinates?.latitude ?? null,
        longitude: locality.coordinates?.longitude ?? null,
        elevationM: locality.elevationM,
        areaDunums: locality.areaDunums,
        locationDescription: locality.locationDescription,
        historicalOverview: locality.historicalOverview,
        geoDisplayName: null,
        geoEnrichedAt: null,
      },
      create: {
        slug: locality.slug,
        nameAr: locality.nameAr,
        nameEn: locality.nameEn,
        pcbsCode: locality.pcbsLocalityCode,
        governorateId,
        localAuthorityId,
        nameOrigin: locality.nameOrigin,
        nameOriginSourceId,
        latitude: locality.coordinates?.latitude ?? null,
        longitude: locality.coordinates?.longitude ?? null,
        elevationM: locality.elevationM,
        areaDunums: locality.areaDunums,
        locationDescription: locality.locationDescription,
        historicalOverview: locality.historicalOverview,
      },
    });

    await seedVillageChildren(locality, village.id, sourceIdsByJsonId);
  }
}

async function main(): Promise<void> {
  const data = loadLocalities();

  await seedAdmin();
  const governorateIdsByArabicName = await seedGovernorates();
  const sourceIdsByJsonId = await seedSources(data);
  await seedVillages(data, governorateIdsByArabicName, sourceIdsByJsonId);

  console.log('Seed completed with source-backed locality data.');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error('Seed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
