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

  /**
   * Orígenes que pueden llamar a la API desde un navegador, separados por coma.
   *
   * El browser bloquea por defecto que una página de un origen llame a otro
   * (CORS). El default apunta al Next de desarrollo. En producción va el dominio
   * real; nunca `*`, porque anularía la protección.
   */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  // --- Negocio ------------------------------------------------------------
  /** Días de prueba que recibe un tenant nuevo al registrarse. */
  TRIAL_DAYS: z.coerce.number().int().positive().default(14),

  /**
   * Base de las URLs que se le muestran al usuario final (hoy, el link de
   * activación de un empleado invitado). Es el frontend, no esta API.
   */
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  /**
   * Vida del link de invitación de un empleado, en horas. Corto a propósito:
   * mientras está vivo, cualquiera con el link puede tomar esa cuenta.
   */
  EMPLOYEE_INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(72),
});

export type Env = z.infer<typeof envSchema>;
