export function validateFacilitiesTarget(env) {
  const token = env.QARYATI_FACILITIES_RUN;
  if (!/^[a-f0-9]{24}$/.test(token ?? '')) throw new Error('Disposable Facilities runner required');
  const name = `facilities_it_${token}`;
  const db = new URL(env.DATABASE_URL ?? '');
  const cache = new URL(env.REDIS_URL ?? '');
  const port = value => /^\d+$/.test(value) && Number(value) > 1024 && Number(value) <= 65535;
  if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || !port(db.port) ||
      db.pathname !== `/${name}` || db.username !== name || !/^[a-f0-9]{48}$/.test(db.password) ||
      db.search || db.hash || cache.protocol !== 'redis:' || cache.hostname !== '127.0.0.1' ||
      !port(cache.port) || cache.port === db.port || cache.pathname !== '/0' ||
      cache.username || cache.password || cache.search || cache.hash) {
    throw new Error('Refusing non-disposable Facilities database/cache target');
  }
  return { token, name };
}
