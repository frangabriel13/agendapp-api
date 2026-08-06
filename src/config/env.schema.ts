import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (v) => v.startsWith('postgresql://') || v.startsWith('postgres://'),
      {
        message: 'DATABASE_URL must start with postgresql:// or postgres://',
      },
    ),

  // --- Auth ---------------------------------------------------------------
  // Solo hay un secreto porque el refresh token NO es un JWT: es un token
  // opaco (`<id>.<secret>`) validado contra la tabla refresh_tokens.
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters long'),
  JWT_ACCESS_EXPIRES_IN: z.string().min(1).default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // --- Negocio ------------------------------------------------------------
  /** Días de prueba que recibe un tenant nuevo al registrarse. */
  TRIAL_DAYS: z.coerce.number().int().positive().default(14),
});

export type Env = z.infer<typeof envSchema>;
