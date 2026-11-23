import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PLACEHOLDER = 'replace_with_at_least_32_characters_secret';

class ExitCalled extends Error {}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new ExitCalled(); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function loadEnv(nodeEnv: string, secret: string) {
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('JWT_ACCESS_SECRET', secret);
  return import('../src/config/env.js');
}

describe('JWT_ACCESS_SECRET placeholder', () => {
  it('matches the value shipped in .env.example', async () => {
    const { readFile } = await import('node:fs/promises');
    const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    const { EXAMPLE_JWT_ACCESS_SECRET } = await loadEnv('test', 'a-real-secret-that-is-long-enough-123456');

    expect(example).toContain(`JWT_ACCESS_SECRET=${EXAMPLE_JWT_ACCESS_SECRET}`);
    expect(EXAMPLE_JWT_ACCESS_SECRET).toBe(PLACEHOLDER);
  });

  it('stops the app in production', async () => {
    await expect(loadEnv('production', PLACEHOLDER)).rejects.toBeInstanceOf(ExitCalled);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('JWT_ACCESS_SECRET'));
  });

  it.each(['development', 'test'])('only warns in %s', async (nodeEnv) => {
    const { env } = await loadEnv(nodeEnv, PLACEHOLDER);

    expect(env.JWT_ACCESS_SECRET).toBe(PLACEHOLDER);
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('JWT_ACCESS_SECRET'));
  });

  it('accepts a real secret in production without warnings', async () => {
    const { env } = await loadEnv('production', 'a-real-secret-that-is-long-enough-123456');

    expect(env.NODE_ENV).toBe('production');
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('still rejects secrets shorter than 32 characters', async () => {
    await expect(loadEnv('development', 'too-short')).rejects.toBeInstanceOf(ExitCalled);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('JWT_ACCESS_SECRET'));
  });
});
