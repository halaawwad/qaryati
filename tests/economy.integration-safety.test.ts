import { describe, expect, it } from 'vitest';
import { validateEconomyTarget } from '../scripts/economy-integration-safety.mjs';

const token = 'a'.repeat(24);
const name = `economy_it_${token}`;
const env = {
  QARYATI_ECONOMY_RUN: token,
  DATABASE_URL: `postgresql://${name}:${'b'.repeat(48)}@127.0.0.1:55123/${name}`,
  REDIS_URL: 'redis://127.0.0.1:55124/0',
};
describe('Economy disposable environment guard', () => {
  it('accepts only the run-specific localhost database and Redis target', () => {
    expect(validateEconomyTarget(env)).toEqual({ token, name });
  });
  it.each([
    { QARYATI_ECONOMY_RUN: undefined },
    { QARYATI_ECONOMY_RUN: 'invalid' },
    { DATABASE_URL: 'postgresql://qaryati:password@localhost:5432/qaryati' },
    { DATABASE_URL: env.DATABASE_URL.replace('/' + name, '/qaryati_local') },
    { DATABASE_URL: env.DATABASE_URL.replace('127.0.0.1', 'db.example.com') },
    { DATABASE_URL: env.DATABASE_URL.replace(name + ':', 'other:') },
    { DATABASE_URL: env.DATABASE_URL + '?schema=public' },
    { DATABASE_URL: env.DATABASE_URL + '#fragment' },
    { REDIS_URL: 'redis://localhost:6379/0' },
    { REDIS_URL: 'redis://127.0.0.1:55124/1' },
    { REDIS_URL: 'redis://127.0.0.1:55123/0' },
    { REDIS_URL: 'redis://127.0.0.1:55124/0?unsafe=1' },
  ])('fails closed for unsafe configuration %j', override => {
    expect(() => validateEconomyTarget({ ...env, ...override })).toThrow();
  });
});
