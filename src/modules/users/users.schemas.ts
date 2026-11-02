import { z } from 'zod';

export const userRoleSchema = z.enum(['ADMIN', 'REVIEWER', 'EDITOR']);
export const userParamsSchema = z.object({ id: z.uuid() });
export const updateRoleSchema = z.object({ role: userRoleSchema });
export const updateStatusSchema = z.object({ isActive: z.boolean() });
export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  role: userRoleSchema.optional(),
  isActive: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  q: z.string().trim().max(100).transform((value) => value || undefined).optional(),
  sort: z.enum(['createdAt', 'email', 'fullName']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export type UserRole = z.infer<typeof userRoleSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
