import { afterEach, describe, expect, it, vi } from 'vitest';
import { NominatimProvider, retryAfterMs, type NominatimOptions } from '../src/integrations/geo/nominatim.provider.js';
import { RedisGeoStore, GeoCandidateStore, geoIdentity, type GeoStore } from '../src/integrations/geo/geo.store.js';
import { RedisGeoLimiter } from '../src/integrations/geo/geo.limiter.js';
import { safeGeoEndpoint, validGeoUserAgent } from '../src/integrations/geo/geo.config.js';
import { publicGeoAddress } from '../src/integrations/geo/geo.transport.js';
import type { GeoLookup } from '../src/integrations/geo/geo.provider.js';
import type { Redis } from 'ioredis';

const input: GeoLookup = { nameAr: 'بتير', nameEn: 'Battir', governorate: { nameAr: 'بيت لحم', nameEn: 'Bethlehem' }, countryCode: 'ps' };
const row = { lat: '31.7', lon: '35.1', display_name: 'Test fixture', name: 'بتير', osm_type: 'node', osm_id: 123,
  address: { country_code: 'ps', state: 'Bethlehem Governorate', village: 'بتير' } };
const options: NominatimOptions = { endpoint: 'https://nominatim.openstreetmap.org/search', userAgent: 'Qaryati/1.0 (https://qaryati.test/contact)', timeoutMs: 100,
  cacheTtlSeconds: 2592000, negativeTtlSeconds: 300, circuitThresholdPercent: 50, circuitResetMs: 50 };
const providers: NominatimProvider[] = [];
function fixture(overrides: Partial<NominatimOptions> = {}) {
  const store = { get: vi.fn<GeoStore['get']>().mockResolvedValue(null), put: vi.fn<GeoStore['put']>().mockResolvedValue() };
  const release = vi.fn().mockResolvedValue(undefined);
  const limiter = { acquire: vi.fn().mockResolvedValue({ release }) };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([row]));
  const sleep = vi.fn().mockResolvedValue(undefined);
  const provider = new NominatimProvider({ ...options, ...overrides }, limiter, store, fetcher, sleep);
  providers.push(provider);
  return { provider, store, release, limiter, fetcher, sleep };
}
afterEach(() => { providers.forEach(provider => provider.circuit.shutdown()); providers.length = 0; vi.useRealTimers(); });

describe('Nominatim provider', () => {
  it('finds Al Walaja by name alone, releasing a permit before each fallback and stopping on success', async () => {
    const { provider, fetcher, limiter, release } = fixture();
    const lookup = { ...input, nameAr: 'الولجة', nameEn: 'Al Walaja' };
    const queries: string[] = [];
    fetcher.mockImplementation(async url => {
      expect(limiter.acquire).toHaveBeenCalledTimes(queries.length + 1);
      expect(release).toHaveBeenCalledTimes(queries.length);
      const params = new URL(String(url)).searchParams;
      expect(params.get('countrycodes')).toBe('ps');
      queries.push(params.get('q')!);
      return Response.json(queries.length < 3 ? [] : [{ ...row,
        lat: '31.7306702', lon: '35.1613881', osm_id: 41633517, name: 'Al-Walaja',
        namedetails: { 'name:ar': 'الولجة', 'name:en': 'Al-Walaja' },
        address: { country_code: 'ps', state: 'اليهودا والسامرة', county: 'منطقة ج' },
      }]);
    });
    expect(await provider.lookup(lookup)).toMatchObject([{
      latitude: 31.7306702, longitude: 35.1613881, providerReference: 'node/41633517',
      match: { name: 'exact', governorate: 'unconfirmed' },
    }]);
    expect(queries).toEqual(['الولجة, بيت لحم, Palestine', 'Al Walaja, Bethlehem, Palestine', 'Al Walaja']);
    expect(release.mock.calls).toEqual([[1000], [1000], [1000]]);
  });
  it.each([null, 'Battir'])('reaches Arabic name-only fallback with English name %s', async nameEn => {
    const { provider, fetcher } = fixture();
    fetcher.mockImplementation(async url => Response.json(new URL(String(url)).searchParams.get('q') === input.nameAr ? [row] : []));
    expect(await provider.lookup({ ...input, nameEn })).toHaveLength(1);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('q'))).toEqual(
      nameEn ? ['بتير, بيت لحم, Palestine', 'Battir, Bethlehem, Palestine', 'Battir', 'بتير'] : ['بتير, بيت لحم, Palestine', 'بتير']);
  });
  it.each([
    [{ state: 'Bethlehem' }, 'unconfirmed'],
    [{ county: 'Bethlehem', state_district: 'West Bank' }, 'unconfirmed'],
    [{ governorate: 'Bethlehem' }, 'exact'],
    [{ state: 'محافظة بيت لحم' }, 'exact'],
    [{ county: 'Bethlehem Governorate' }, 'exact'],
    [{ governorate: 'Hebron' }, null],
    [{ state_district: 'محافظة الخليل' }, null],
    [{ governorate: 'Bethlehem', county: 'Hebron Governorate' }, null],
  ] as const)('classifies explicit versus ambiguous governorate context: %j', async (address, expected) => {
    const { provider, fetcher } = fixture();
    fetcher.mockImplementation(async () => Response.json([{ ...row, address: { country_code: 'ps', ...address } }]));
    const results = await provider.lookup(input);
    if (expected === null) expect(results).toEqual([]);
    else expect(results[0]?.match.governorate).toBe(expected);
  });
  it.each(['us', undefined, ''])('rejects country %s at every fallback', async country_code => {
    const { provider, fetcher, limiter } = fixture();
    fetcher.mockImplementation(async () => Response.json([{ ...row, address: { country_code } }]));
    expect(await provider.lookup(input)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(limiter.acquire).toHaveBeenCalledTimes(4);
  });
  it('bypasses old negative cache entries without deleting shared state', async () => {
    const { provider, store, fetcher } = fixture();
    store.get.mockImplementation(async key => key.includes(':nominatim:v2:') ? null : '[]');
    expect(await provider.lookup(input)).toHaveLength(1);
    expect(store.get).toHaveBeenCalledWith(expect.stringContaining(':lookup:nominatim:v2:'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('revalidates cached countries before returning candidates', async () => {
    const { provider, store, fetcher } = fixture();
    const candidates = await provider.lookup(input);
    store.get.mockResolvedValue(JSON.stringify(candidates.map(candidate => ({ ...candidate, address: { country_code: 'us' } }))));
    expect(await provider.lookup(input)).toEqual(candidates);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('shares the retry budget across fallback queries and never caches an interrupted search', async () => {
    const { provider, fetcher, limiter, store } = fixture();
    fetcher.mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockImplementation(async () => new Response('', { status: 503 }));
    await expect(provider.lookup(input)).rejects.toMatchObject({ code: 'GEO_PROVIDER_ERROR' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(limiter.acquire).toHaveBeenCalledTimes(4);
    expect(store.put).not.toHaveBeenCalled();
  });
  it('uses stored context, bounded structured results and a contact User-Agent', async () => {
    const { provider, fetcher, store, release } = fixture();
    const result = await provider.lookup(input);
    expect(result[0]).toMatchObject({ latitude: 31.7, longitude: 35.1, providerReference: 'node/123', match: { name: 'exact', governorate: 'exact' } });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.get('q')).toContain('بتير, بيت لحم, Palestine');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ limit: '5', countrycodes: 'ps', addressdetails: '1', format: 'jsonv2' });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { 'User-Agent': options.userAgent } });
    expect(store.put).toHaveBeenCalledWith(expect.any(String), JSON.stringify(result), 2592000);
    expect(release).toHaveBeenCalledWith(1000);
  });
  it('negatively caches empty and mismatched results', async () => {
    const { provider, fetcher, store } = fixture();
    fetcher.mockImplementation(async () => Response.json([{ ...row, address: { country_code: 'us' } }, { ...row, address: { country_code: 'ps', state: 'Other Governorate' } }]));
    expect(await provider.lookup(input)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(store.put).toHaveBeenCalledWith(expect.any(String), '[]', 300);
  });
  it('reports unconfirmed names/context without invented confidence', async () => {
    const { provider, fetcher } = fixture();
    fetcher.mockResolvedValue(Response.json([{ ...row, name: 'Other', address: { country_code: 'ps' } }]));
    expect((await provider.lookup(input))[0]!.match).toEqual({ name: 'unconfirmed', governorate: 'unconfirmed' });
  });
  it('does not infer a governorate from an unclassified state name', async () => {
    const { provider, fetcher } = fixture();
    fetcher.mockResolvedValue(Response.json([{ ...row, address: { country_code: 'ps', state: 'Hebron' } }]));
    expect((await provider.lookup(input))[0]?.match.governorate).toBe('unconfirmed');
  });
  it('treats territory-level state as unconfirmed governorate context', async () => {
    const { provider, fetcher } = fixture();
    fetcher.mockResolvedValue(Response.json([{ ...row, address: { country_code: 'ps', state: 'West Bank' } }]));
    expect((await provider.lookup(input))[0]?.match.governorate).toBe('unconfirmed');
  });
  it.each(['not-json', JSON.stringify([{ ...row, lat: 'NaN' }]), JSON.stringify([{ ...row, lon: '181' }]), JSON.stringify([{ ...row, lat: '' }]), JSON.stringify({ results: [] })])('rejects invalid response without retry or caching: %s', async body => {
    const { provider, fetcher, store } = fixture(); fetcher.mockResolvedValue(new Response(body));
    await expect(provider.lookup(input)).rejects.toMatchObject({ code: 'GEO_INVALID_RESPONSE' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(store.put).not.toHaveBeenCalled();
  });
  it('rejects oversized bodies', async () => {
    const { provider, fetcher } = fixture(); fetcher.mockResolvedValue(new Response(' '.repeat(131073)));
    await expect(provider.lookup(input)).rejects.toMatchObject({ code: 'GEO_INVALID_RESPONSE' });
  });
  it.each([400, 401, 403, 404])('does not retry HTTP %i', async status => {
    const { provider, fetcher } = fixture(); fetcher.mockImplementation(async () => new Response('', { status }));
    await expect(provider.lookup(input)).rejects.toMatchObject({ code: 'GEO_PROVIDER_ERROR' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([500, 502, 503, 504])('retries HTTP %i at most twice, with a permit per attempt', async status => {
    const { provider, fetcher, limiter, sleep } = fixture(); fetcher.mockImplementation(async () => new Response('', { status }));
    await expect(provider.lookup(input)).rejects.toMatchObject({ code: 'GEO_PROVIDER_ERROR' });
    expect(fetcher).toHaveBeenCalledTimes(3); expect(limiter.acquire).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });
  it('recovers after a transient network error', async () => {
    const { provider, fetcher } = fixture(); fetcher.mockRejectedValueOnce(new TypeError('secret internal URL'));
    expect(await provider.lookup(input)).toHaveLength(1); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('aborts timed out calls and limits retries', async () => {
    vi.useFakeTimers();
    const { provider, fetcher } = fixture();
    fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    const result = expect(provider.lookup(input)).rejects.toMatchObject({ code: 'GEO_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(400); await result; expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('honors Retry-After globally and does not retry 429', async () => {
    const { provider, fetcher, release } = fixture(); fetcher.mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(provider.lookup(input)).rejects.toMatchObject({ code: 'GEO_THROTTLED' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledWith(120000);
    expect(retryAfterMs(new Date(120000).toUTCString(), 0)).toBe(120000);
    expect(retryAfterMs('invalid')).toBe(60000);
  });
  it('opens, rejects without upstream work, and recovers via a half-open probe', async () => {
    vi.useFakeTimers(); const { provider, fetcher } = fixture();
    fetcher.mockImplementation(async () => new Response('', { status: 503 }));
    await expect(provider.lookup(input)).rejects.toMatchObject({ code: 'GEO_PROVIDER_ERROR' });
    await expect(provider.lookup(input)).rejects.toMatchObject({ code: 'GEO_CIRCUIT_OPEN' });
    expect(provider.circuit.opened).toBe(true);
    const calls = fetcher.mock.calls.length;
    await expect(provider.lookup(input)).rejects.toMatchObject({ code: 'GEO_CIRCUIT_OPEN' });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(51); expect(provider.circuit.halfOpen).toBe(true);
    fetcher.mockResolvedValue(Response.json([row]));
    await provider.lookup(input); expect(provider.circuit.closed).toBe(true);
  });
  it('uses cache hits including negatives and normalizes equivalent identity keys', async () => {
    const { provider, store, fetcher } = fixture(); store.get.mockResolvedValue('[]');
    expect(await provider.lookup(input)).toEqual([]);
    await provider.lookup({ ...input, nameEn: '  BATTIR  ' });
    expect(store.get.mock.calls[0]).toEqual(store.get.mock.calls[1]); expect(fetcher).not.toHaveBeenCalled();
    expect(geoIdentity(input)).not.toEqual(geoIdentity({ ...input, governorate: { nameAr: 'Other', nameEn: 'Other' } }));
  });
  it('fails closed when cache or coordination is unavailable', async () => {
    const { provider, store, fetcher, limiter } = fixture();
    store.get.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(provider.lookup(input)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    limiter.acquire.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(provider.lookup(input)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('geo storage and network safety', () => {
  it.each(['http://nominatim.openstreetmap.org/search', 'https://127.0.0.1/search', 'https://[::1]/search', 'https://user:pass@host.test/search', 'https://host.test/search?url=x', 'https://host.local/search', 'https://host.test:8443/search'])('rejects unsafe endpoint %s', url => expect(safeGeoEndpoint(url)).toBe(false));
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1'])('rejects unsafe socket address %s', ip => expect(publicGeoAddress(ip)).toBe(false));
  it('allows public addresses and validates identifying contact', () => {
    expect(publicGeoAddress('8.8.8.8')).toBe(true); expect(publicGeoAddress('2606:4700:4700::1111')).toBe(true);
    expect(validGeoUserAgent(options.userAgent)).toBe(true); expect(validGeoUserAgent('fetch')).toBe(false);
  });
  it('fails closed for disconnected Redis without queuing commands', async () => {
    const client = { status: 'reconnecting', get: vi.fn(), set: vi.fn(), eval: vi.fn() };
    const store = new RedisGeoStore(client as unknown as Redis);
    await expect(store.get('key')).rejects.toMatchObject({ code: 'GEO_CACHE_UNAVAILABLE' });
    await expect(store.put('key', 'value', 60)).rejects.toMatchObject({ code: 'GEO_CACHE_UNAVAILABLE' });
    await expect(new RedisGeoLimiter(client as unknown as Redis).acquire()).rejects.toMatchObject({ code: 'GEO_COORDINATION_UNAVAILABLE' });
    expect(client.eval).not.toHaveBeenCalled(); expect(client.get).not.toHaveBeenCalled();
  });
  it('bounds commands against a connected but unresponsive Redis', async () => {
    vi.useFakeTimers();
    const never = () => new Promise<never>(() => {});
    const client = { status: 'ready', get: vi.fn(never), set: vi.fn(never), eval: vi.fn(never) };
    const store = new RedisGeoStore(client as unknown as Redis);
    const checks = [
      expect(store.get('key')).rejects.toMatchObject({ code: 'GEO_CACHE_UNAVAILABLE' }),
      expect(store.put('key', 'value', 60)).rejects.toMatchObject({ code: 'GEO_CACHE_UNAVAILABLE' }),
      expect(new RedisGeoLimiter(client as unknown as Redis).acquire()).rejects.toMatchObject({ code: 'GEO_COORDINATION_UNAVAILABLE' }),
    ];
    await vi.advanceTimersByTimeAsync(2001); await Promise.all(checks);
  });
  it('fails closed if a permit cannot be safely released', async () => {
    const client = { status: 'ready', eval: vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('Redis lost')) };
    const permit = await new RedisGeoLimiter(client as unknown as Redis).acquire();
    await expect(permit.release()).rejects.toMatchObject({ code: 'GEO_COORDINATION_UNAVAILABLE' });
  });
  it('bounds limiter waiting and requires activation', async () => {
    const client = { status: 'ready', eval: vi.fn().mockResolvedValue(-1) };
    await expect(new RedisGeoLimiter(client as unknown as Redis).acquire()).rejects.toMatchObject({ code: 'GEO_DISABLED' });
    client.eval.mockResolvedValue(0);
    await expect(new RedisGeoLimiter(client as unknown as Redis, 1).acquire()).rejects.toMatchObject({ code: 'GEO_BUSY' });
  });
  it('issues village-bound candidates with TTL and rejects expiration or corruption', async () => {
    const values = new Map<string, string>();
    const put = vi.fn(async (key: string, value: string) => { values.set(key, value); });
    const candidates = new GeoCandidateStore({ get: async key => values.get(key) ?? null, put }, 900);
    const candidate = (await fixture().provider.lookup(input))[0]!;
    const ref = await candidates.issue({ villageId: '11111111-1111-4111-8111-111111111111', version: 1, identity: geoIdentity(input), candidate });
    expect(put).toHaveBeenCalledWith(expect.any(String), expect.any(String), 900);
    expect((await candidates.read(ref.candidateRef))?.candidate).toEqual(candidate);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 901000);
    expect(await candidates.read(ref.candidateRef)).toBeNull();
    values.set('qaryati:geo:v1:candidate:bad', '{}'); expect(await candidates.read('bad')).toBeNull();
  });
});
