import CircuitBreaker from 'opossum';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GeoError } from './geo.errors.js';
import { geoCandidateSchema, normalizeGeoText, type GeoCandidate, type GeoLookup, type GeoProvider } from './geo.provider.js';
import type { GeoLimiter } from './geo.limiter.js';
import { geoIdentity, type GeoStore } from './geo.store.js';
import { secureGeoFetch } from './geo.transport.js';
import { safeGeoEndpoint, validGeoUserAgent } from './geo.config.js';

const coordinate = (min: number, max: number) => z.string().trim().min(1).transform(Number).pipe(z.number().min(min).max(max));
const resultSchema = z.array(z.object({
  lat: coordinate(-90, 90), lon: coordinate(-180, 180), display_name: z.string().min(1).max(2000),
  osm_type: z.enum(['node', 'way', 'relation']).optional(), osm_id: z.number().int().positive().optional(),
  name: z.string().optional(), namedetails: z.record(z.string(), z.string()).optional(),
  address: z.record(z.string().max(100), z.string().max(1000)),
})).max(5);

export interface NominatimOptions {
  endpoint: string; userAgent: string; timeoutMs: number;
  cacheTtlSeconds: number; negativeTtlSeconds: number;
  circuitThresholdPercent: number; circuitResetMs: number;
}

function governorateName(value: string): string {
  return normalizeGeoText(value).replace(/\bgovernorate\b/g, '').replace(/محافظة/g, '').trim();
}

function searchQueries(input: GeoLookup): string[] {
  const arabic = input.nameAr.trim();
  const english = input.nameEn?.trim();
  const queries = [
    arabic && [arabic, input.governorate.nameAr || input.governorate.nameEn, 'Palestine'].join(', '),
    english && [english, input.governorate.nameEn || input.governorate.nameAr, 'Palestine'].join(', '),
    // Transliteration-only search can succeed when the address uses a regional
    // classification instead of a governorate. Country filtering remains mandatory.
    english,
    arabic,
  ];
  const seen = new Set<string>();
  return queries.filter((query): query is string => {
    if (!query) return false;
    const key = normalizeGeoText(query);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function explicitGovernorates(address: Record<string, string>): string[] {
  // Administrative levels differ across OSM data. A plain state/state_district/
  // county is not evidence of a governorate, even if its text matches the input.
  const labelled = [address.state, address.state_district, address.county]
    .filter((value): value is string => !!value && /\bgovernorate\b|محافظة/i.test(value));
  return [address.governorate, ...labelled].filter((value): value is string => !!value?.trim());
}

export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (header && /^\d{1,10}$/.test(header)) return Math.max(1000, Number(header) * 1000);
  const date = header ? Date.parse(header) : NaN;
  return Number.isFinite(date) ? Math.max(1000, date - now) : 60000;
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new GeoError('GEO_INVALID_RESPONSE', 'Geographic provider returned an invalid response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131072) throw new GeoError('GEO_INVALID_RESPONSE', 'Geographic provider response is too large');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new GeoError('GEO_INVALID_RESPONSE', 'Geographic provider returned invalid JSON'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class NominatimProvider implements GeoProvider {
  readonly cacheIdentity: string;
  readonly circuit: CircuitBreaker<[GeoLookup, string], GeoCandidate[]>;
  constructor(
    private readonly options: NominatimOptions,
    private readonly limiter: GeoLimiter,
    private readonly store: GeoStore,
    private readonly fetcher: typeof fetch = secureGeoFetch,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {
    if (!safeGeoEndpoint(options.endpoint) || !validGeoUserAgent(options.userAgent)) {
      throw new GeoError('GEO_CONFIGURATION', 'Geographic provider configuration is incomplete');
    }
    this.cacheIdentity = 'nominatim:v2:' + createHash('sha256').update(options.endpoint).digest('hex');
    this.circuit = new CircuitBreaker((input, query) => this.attempt(input, query), {
      // AbortController covers fetch AND body reading; no orphaned work after an opossum timeout.
      timeout: false, errorThresholdPercentage: options.circuitThresholdPercent,
      resetTimeout: options.circuitResetMs, volumeThreshold: 5, rollingCountTimeout: 60000,
      errorFilter: error => error instanceof GeoError && !error.transient,
    });
  }

  async lookup(input: GeoLookup): Promise<GeoCandidate[]> {
    const key = 'qaryati:geo:v1:lookup:' + this.cacheIdentity + ':' + geoIdentity(input);
    const cached = await this.store.get(key);
    if (cached) {
      try {
        const candidates = z.array(geoCandidateSchema).max(5).parse(JSON.parse(cached));
        if (candidates.every(candidate => candidate.address.country_code?.toLowerCase() === input.countryCode)) return candidates;
        // Invalid country data must not turn a cache hit into a false no-match.
      }
      catch { /* Corrupt cache is never presented as a candidate. Revalidate upstream. */ }
    }
    // A single retry budget covers the whole lookup, including fallbacks: at most
    // four distinct queries plus two transient retries, never parallel requests.
    let retries = 0;
    for (const query of searchQueries(input)) {
      let candidates: GeoCandidate[];
      for (;;) {
        try {
          candidates = await this.circuit.fire(input, query);
          break;
        } catch (error) {
          if (!(error instanceof GeoError)) throw new GeoError('GEO_CIRCUIT_OPEN', 'Geographic provider circuit is open; try again later');
          if (!error.transient || retries === 2) throw error;
          await this.sleep(250 * 2 ** retries++);
        }
      }
      if (candidates.length) {
        await this.store.put(key, JSON.stringify(candidates), this.options.cacheTtlSeconds);
        return candidates;
      }
    }
    // Only a completed, unsuccessful search sequence is a negative cache result.
    await this.store.put(key, '[]', this.options.negativeTtlSeconds);
    return [];
  }

  private async attempt(input: GeoLookup, query: string): Promise<GeoCandidate[]> {
    const permit = await this.limiter.acquire();
    let cooldownMs = 1000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs);
    try {
      const url = new URL(this.options.endpoint);
      url.search = new URLSearchParams({
        q: query,
        format: 'jsonv2', addressdetails: '1', namedetails: '1', countrycodes: input.countryCode,
        limit: '5', 'accept-language': 'ar,en',
      }).toString();
      const response = await this.fetcher(url, { headers: { 'User-Agent': this.options.userAgent, Accept: 'application/json' }, signal: abort.signal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) {
          cooldownMs = retryAfterMs(response.headers.get('retry-after'));
          throw new GeoError('GEO_THROTTLED', 'Geographic provider requested a pause; try again later');
        }
        throw new GeoError('GEO_PROVIDER_ERROR', 'Geographic provider could not complete the lookup', [500, 502, 503, 504].includes(response.status));
      }
      const parsed = resultSchema.safeParse(await boundedJson(response));
      if (!parsed.success) throw new GeoError('GEO_INVALID_RESPONSE', 'Geographic provider returned invalid location data');
      const candidates: GeoCandidate[] = [];
      for (const item of parsed.data) {
        if (item.address.country_code?.toLowerCase() !== input.countryCode) continue;
        const expectedGovernorates = [input.governorate.nameAr, input.governorate.nameEn].map(governorateName);
        const governorates = explicitGovernorates(item.address);
        if (governorates.some(value => !expectedGovernorates.includes(governorateName(value)))) continue;
        const names = [item.name, ...Object.values(item.namedetails ?? {}), item.address.village, item.address.town, item.address.city]
          .filter((value): value is string => !!value).map(normalizeGeoText);
        const exactName = [input.nameAr, input.nameEn].some(name => name && names.includes(normalizeGeoText(name)));
        candidates.push({
          latitude: item.lat, longitude: item.lon, displayName: item.display_name, provider: 'nominatim',
          providerReference: item.osm_type && item.osm_id ? item.osm_type + '/' + item.osm_id : null,
          address: item.address, match: { name: exactName ? 'exact' : 'unconfirmed', governorate: governorates.length ? 'exact' : 'unconfirmed' },
        });
      }
      return candidates;
    } catch (error) {
      if (error instanceof GeoError) throw error;
      throw new GeoError(abort.signal.aborted ? 'GEO_TIMEOUT' : 'GEO_NETWORK_ERROR',
        abort.signal.aborted ? 'Geographic provider timed out' : 'Geographic provider connection failed', true);
    } finally {
      clearTimeout(timer);
      await permit.release(cooldownMs);
    }
  }
}
