// Creates its own databases. Never uses DATABASE_URL or REDIS_URL from .env/the caller.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const containers = [];
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 }).trim();
function start(image, port, extra = []) {
  const id = docker(['run', '--rm', '-d', '--name', 'qaryati-geo-test-' + randomUUID(),
    ...extra, '-p', '127.0.0.1::' + port, image]);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Unexpected container identity');
  containers.push(id);
  const address = docker(['port', id, port + '/tcp']);
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Unexpected disposable service address');
  return { id, address };
}
try {
  const pg = start('postgres:16-alpine', 5432, ['-e', 'POSTGRES_USER=geo_test', '-e', 'POSTGRES_PASSWORD=disposable', '-e', 'POSTGRES_DB=qaryati_geo_disposable']);
  const cache = start('redis:7-alpine', 6379);
  for (const [container, command] of [[pg.id, ['pg_isready', '-U', 'geo_test', '-d', 'qaryati_geo_disposable']], [cache.id, ['redis-cli', 'ping']]]) {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { docker(['exec', container, ...command]); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!ready) throw new Error('Disposable service did not become ready');
  }
  const env = { ...process.env,
    DATABASE_URL: 'postgresql://geo_test:disposable@' + pg.address + '/qaryati_geo_disposable',
    REDIS_URL: 'redis://' + cache.address + '/0', QARYATI_GEO_DISPOSABLE: '1',
    NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_ENABLED: 'false',
    JWT_ACCESS_SECRET: 'disposable-geo-test-secret-at-least-32-characters',
    GEO_ENABLED: 'true', GEO_USER_AGENT: 'QaryatiTest/1.0 (https://qaryati.test/contact)',
  };
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env, stdio: 'inherit', timeout: 60000 });
  execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts',
    'tests/integration/geo.integration.ts'], { env, stdio: 'inherit', timeout: 180000 });
} catch (error) {
  console.error('Disposable geo integration verification failed:', error.message);
  process.exitCode = 1;
} finally {
  for (const id of containers.reverse()) {
    try { docker(['rm', '-f', '-v', id]); }
    catch { console.error('Cleanup failed for disposable container ' + id); process.exitCode = 1; }
  }
  console.log('Disposable geo container cleanup finished.');
}
