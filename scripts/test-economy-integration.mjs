import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateEconomyTarget } from './economy-integration-safety.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const token = randomBytes(12).toString('hex');
const name = `economy_it_${token}`;
const password = randomBytes(24).toString('hex');
const label = `qaryati.economy-integration=${token}`;
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
    // Do not echo Docker environment/connection details on failure.
    child.stderr?.on('data', chunk => { if (diagnostics) output += chunk; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', () => { clearTimeout(timer); reject(new Error(`${command} could not start`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (active === child) active = undefined;
      const safeOutput = output.replaceAll(password, '[redacted]')
        .replace(/(?:postgres(?:ql)?|redis):\/\/[^\s]+/g, '[connection URL redacted]');
      code === 0 ? resolve(output.trim()) : reject(new Error(`${command} failed (exit ${code})${diagnostics ? '\n' + safeOutput : ''}`));
    });
  });
}
const docker = (...args) => run('docker', args);
async function waitReady(check) {
  for (let i = 0; i < 60; i++) {
    if (interrupted) throw new Error('Interrupted');
    try { await check(); return; } catch { await delay(500); }
  }
  throw new Error('Disposable service readiness timed out');
}
async function container(suffix, image, args) {
  const containerName = `${name}_${suffix}`;
  // Register before creation so a failed start is still cleaned up by its unique label.
  owned.push(containerName);
  await docker('create', '--name', containerName, '--label', label, ...args, image);
  await docker('start', containerName);
  return containerName;
}
async function mappedPort(containerName, internal) {
  const info = JSON.parse(await docker('inspect', containerName))[0];
  const bindings = info.NetworkSettings.Ports[`${internal}/tcp`];
  if (info.Config.Labels['qaryati.economy-integration'] !== token || bindings?.length !== 1 ||
      bindings[0].HostIp !== '127.0.0.1') throw new Error('Disposable container identity/binding mismatch');
  return bindings[0].HostPort;
}
try {
  console.log('Starting disposable PostgreSQL 16 and Redis 7 for Economy integration tests.');
  await docker('info', '--format', '{{.ServerVersion}}');
  const pg = await container('postgres', 'postgres:16', ['-p', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql/data', '-e', `POSTGRES_DB=${name}`,
    '-e', `POSTGRES_USER=${name}`, '-e', `POSTGRES_PASSWORD=${password}`]);
  const redis = await container('redis', 'redis:7', ['-p', '127.0.0.1::6379', '--tmpfs', '/data']);
  await waitReady(() => docker('exec', pg, 'pg_isready', '-U', name, '-d', name));
  await waitReady(() => docker('exec', redis, 'redis-cli', 'ping'));
  const dbPort = await mappedPort(pg, 5432);
  const redisPort = await mappedPort(redis, 6379);
  // No inherited application configuration or NODE_OPTIONS. No .env is loaded by this runner.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata|comspec)$/i.test(key)));
  Object.assign(env, {
    DATABASE_URL: `postgresql://${name}:${password}@127.0.0.1:${dbPort}/${name}`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}/0`, QARYATI_ECONOMY_RUN: token,
    NODE_ENV: 'production', LOG_LEVEL: 'silent', JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
    RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '10000', TRUST_PROXY: 'false',
  });
  validateEconomyTarget(env);
  const identity = await docker('exec', pg, 'psql', '-U', name, '-d', name, '-Atc',
    'SELECT current_database() || \':\' || current_user');
  if (identity !== `${name}:${name}`) throw new Error('Disposable database identity mismatch');
  await docker('exec', pg, 'psql', '-U', name, '-d', name, '-v', 'ON_ERROR_STOP=1', '-c',
    `COMMENT ON DATABASE ${name} IS '${token}';`);
  await docker('exec', redis, 'redis-cli', 'SET', 'economy-integration-guard', token);
  if (interrupted) throw new Error('Interrupted');
  console.log('Applying existing migrations to the verified disposable database.');
  await run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env, diagnostics: true });
  console.log('Running real HTTP Economy integration tests.');
  await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config',
    'vitest.integration.config.ts', 'tests/integration/economy.postgres.integration.ts'],
  { env, visible: true, timeout: 180000 });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const containerName of owned.reverse()) {
    try {
      const existing = await docker('ps', '-aq', '--filter', `name=^/${containerName}$`);
      if (!existing) continue;
      const info = JSON.parse(await docker('inspect', containerName))[0];
      if (info.Config.Labels['qaryati.economy-integration'] !== token) throw new Error('Cleanup label mismatch');
      await docker('rm', '-f', '-v', containerName);
      console.log(`Removed disposable container ${containerName}`);
    } catch {
      console.error(`Cleanup failed for disposable container ${containerName}`);
      process.exitCode = 1;
    }
  }
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
