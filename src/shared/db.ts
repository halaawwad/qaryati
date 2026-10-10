import { PrismaClient } from '@prisma/client';
import { isDevelopment } from '../config/env.js';

export const prisma = new PrismaClient({
  log: isDevelopment ? ['warn', 'error'] : ['error'],
});
