import { z } from 'zod';

export interface GeoLookup {
  nameAr: string;
  nameEn: string | null;
  governorate: { nameAr: string; nameEn: string };
  countryCode: 'ps';
}

export const geoCandidateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  displayName: z.string().min(1).max(2000),
  provider: z.string().min(1).max(100),
  providerReference: z.string().max(200).nullable(),
  address: z.record(z.string().max(100), z.string().max(1000)),
  match: z.object({ name: z.enum(['exact', 'unconfirmed']), governorate: z.enum(['exact', 'unconfirmed']) }),
});
export type GeoCandidate = z.infer<typeof geoCandidateSchema>;

export interface GeoProvider {
  /** Includes provider/configuration identity so caches cannot cross providers. */
  readonly cacheIdentity: string;
  lookup(input: GeoLookup): Promise<GeoCandidate[]>;
}

export const GEO_ATTRIBUTION = {
  text: '© OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright',
  licence: 'ODbL 1.0',
};

export function normalizeGeoText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}
