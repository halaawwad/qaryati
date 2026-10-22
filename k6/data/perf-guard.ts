// Shared by the synthetic-data scripts. They only ever touch rows whose slug starts with this prefix.
export const PERF_SLUG_PREFIX = 'perf-';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Refuses to run against anything but a local database, so load-test data can't reach a shared one. */
export function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (run through npm so .env is loaded).');

  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to run: DATABASE_URL points at "${host}", not a local database.`);
  }
}
