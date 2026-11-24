// Shared by the runner and tests; validate before importing application clients.
export function validateEconomyTarget(env) {
  const token = env.QARYATI_ECONOMY_RUN;
  if (!/^[a-f0-9]{24}$/.test(token ?? '')) throw new Error('Disposable Economy runner required');
  const name = `economy_it_${token}`;
  const db = new URL(env.DATABASE_URL ?? '');
  const redis = new URL(env.REDIS_URL ?? '');
  const port = value => /^\d+$/.test(value) && Number(value) > 1024 && Number(value) <= 65535;
  if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || !port(db.port) ||
      db.pathname !== `/${name}` || db.username !== name || !/^[a-f0-9]{48}$/.test(db.password) ||
      db.search || db.hash || redis.protocol !== 'redis:' || redis.hostname !== '127.0.0.1' ||
      !port(redis.port) || redis.port === db.port || redis.pathname !== '/0' ||
      redis.username || redis.password || redis.search || redis.hash) {
    throw new Error('Refusing non-disposable Economy database/cache target');
  }
  return { token, name };
}
