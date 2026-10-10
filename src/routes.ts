import { Router } from 'express';
import { redis } from './shared/cache.js';
import { prisma } from './shared/db.js';

const HEALTH_CHECK_TIMEOUT_MS = 2000;

async function check(probe: () => Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Health check timed out')), HEALTH_CHECK_TIMEOUT_MS);
  });

  try {
    await Promise.race([probe(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const router = Router();

router.get('/health', async (_req, res) => {
  const [dbUp, redisUp] = await Promise.all([
    check(() => prisma.$queryRaw`SELECT 1`),
    check(() => redis.ping()),
  ]);
  const healthy = dbUp && redisUp;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'error',
    db: dbUp ? 'up' : 'down',
    redis: redisUp ? 'up' : 'down',
  });
});

// Feature module routers are mounted here as they are implemented, e.g.:
// router.use('/villages', villagesRouter);
