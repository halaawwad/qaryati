import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateHeritageTarget } from './heritage-integration-safety.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const token = randomBytes(12).toString('hex');
const name = `heritage_it_${token}`;
const password = randomBytes(24).toString('hex');
const label = `qaryati.heritage-integration=${token}`;
const owned = [];
let interrupted = false;
let active;
function interrupt() { interrupted = true; active?.kill(); }
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
function run(command, args, { env = process.env, visible = false, diagnostics = false, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      stdio: ['ignore', visible ? 'inherit' : 'pipe', visible ? 'inherit' : 'pipe'] });
    active = child;
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { if (diagnostics) output += chunk; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', () => { clearTimeout(timer); reject(new Error(`${command} could not start`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (active === child) active = undefined;
      const safe = output.replaceAll(password, '[redacted]').replace(/(?:postgres(?:ql)?|redis):\/\/[^\s]+/g, '[URL redacted]');
      code === 0 ? resolve(output.trim()) : reject(new Error(`${command} failed (exit ${code})${diagnostics ? '\n' + safe : ''}`));
    });
  });
}
const docker = (...args) => run('docker', args);
async function ready(check) {
  for (let i = 0; i < 60; i++) {
    if (interrupted) throw new Error('Interrupted');
    try { await check(); return; } catch { await delay(500); }
  }
  throw new Error('Disposable service readiness timed out');
}
async function start(suffix, image, args) {
  const id = `${name}_${suffix}`;
  owned.push(id);
  await docker('create', '--name', id, '--label', label, ...args, image);
  await docker('start', id);
  return id;
}
async function port(id, internal) {
  const info = JSON.parse(await docker('inspect', id))[0];
  const bindings = info.NetworkSettings.Ports[`${internal}/tcp`];
  if (info.Config.Labels['qaryati.heritage-integration'] !== token || bindings?.length !== 1 ||
      bindings[0].HostIp !== '127.0.0.1') throw new Error('Disposable container identity/binding mismatch');
  return bindings[0].HostPort;
}
try {
  console.log('Starting isolated PostgreSQL 16 and Redis 7 for Heritage.');
  await docker('info', '--format', '{{.ServerVersion}}');
  const pg = await start('postgres', 'postgres:16', ['-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
    '-e', `POSTGRES_DB=${name}`, '-e', `POSTGRES_USER=${name}`, '-e', `POSTGRES_PASSWORD=${password}`]);
  const cache = await start('redis', 'redis:7', ['-p', '127.0.0.1::6379', '--tmpfs', '/data']);
  await ready(() => docker('exec', pg, 'pg_isready', '-U', name, '-d', name));
  await ready(() => docker('exec', cache, 'redis-cli', 'ping'));
  const dbPort = await port(pg, 5432);
  const cachePort = await port(cache, 6379);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata|comspec)$/i.test(key)));
  Object.assign(env, {
    DATABASE_URL: `postgresql://${name}:${password}@127.0.0.1:${dbPort}/${name}`,
    REDIS_URL: `redis://127.0.0.1:${cachePort}/0`, QARYATI_HERITAGE_RUN: token,
    NODE_ENV: 'production', LOG_LEVEL: 'silent', JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
    RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '10000', TRUST_PROXY: 'false', GEO_ENABLED: 'false',
  });
  validateHeritageTarget(env);
  const identity = await docker('exec', pg, 'psql', '-U', name, '-d', name, '-Atc',
    'SELECT current_database() || \':\' || current_user');
  if (identity !== `${name}:${name}`) throw new Error('Disposable database identity mismatch');
  await docker('exec', pg, 'psql', '-U', name, '-d', name, '-v', 'ON_ERROR_STOP=1', '-c',
    `COMMENT ON DATABASE ${name} IS '${token}';`);
  await docker('exec', cache, 'redis-cli', 'SET', 'heritage-integration-guard', token);
  if (interrupted) throw new Error('Interrupted');
  console.log('Applying existing migrations to verified disposable database.');
  await run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env, diagnostics: true });
  await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts',
    'tests/integration/heritage.postgres.integration.ts'], { env, visible: true, timeout: 180000 });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const id of owned.reverse()) {
    try {
      if (!await docker('ps', '-aq', '--filter', `name=^/${id}$`)) continue;
      const info = JSON.parse(await docker('inspect', id))[0];
      if (info.Config.Labels['qaryati.heritage-integration'] !== token) throw new Error('Cleanup identity mismatch');
      await docker('rm', '-f', '-v', id);
      console.log(`Removed disposable container ${id}`);
    } catch { console.error(`Cleanup failed for disposable container ${id}`); process.exitCode = 1; }
  }
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
