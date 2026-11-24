import { z } from 'zod';

// bcrypt only uses the first 72 bytes, so longer passwords would be silently truncated.
const MAX_PASSWORD_BYTES = 72;

export const registerSchema = z.object({
  email: z.string().trim().email(),
  password: z
    .string()
    .min(8)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES, {
      message: `Must be at most ${MAX_PASSWORD_BYTES} bytes`,
    }),
  fullName: z.string().trim().min(1),
});

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const logoutSchema = refreshSchema;

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
