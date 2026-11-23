import { describe, expect, it } from 'vitest';
import { registerSchema } from '../src/modules/auth/auth.schemas.js';

const valid = { email: 'hala@example.test', fullName: 'Hala' };

describe('registerSchema password', () => {
  it.each([
    ['8 characters', 'a'.repeat(8)],
    ['72 ASCII characters (72 bytes)', 'a'.repeat(72)],
    ['36 Arabic letters (72 bytes)', 'ق'.repeat(36)],
  ])('accepts %s', (_label, password) => {
    expect(registerSchema.safeParse({ ...valid, password }).success).toBe(true);
  });

  it.each([
    ['7 characters', 'a'.repeat(7)],
    ['73 ASCII characters (73 bytes)', 'a'.repeat(73)],
    ['37 Arabic letters (74 bytes)', 'ق'.repeat(37)],
  ])('rejects %s', (_label, password) => {
    const result = registerSchema.safeParse({ ...valid, password });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['password']);
  });
});
