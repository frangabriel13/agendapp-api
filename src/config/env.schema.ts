import { z } from 'zod';

const baseEnvSchema = z.object({
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

  // --- Mail ---------------------------------------------------------------
  /**
   * `log` no manda nada: escribe el mail (y sus links) en la consola. Es el
   * default para que el proyecto arranque sin credenciales de nadie. En
   * producción va `resend`.
   */
  MAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),

  /** Solo se usa con `MAIL_PROVIDER=resend`, donde pasa a ser obligatoria. */
  RESEND_API_KEY: z.string().min(1).optional(),

  /**
   * El remitente. Con Resend, el dominio tiene que estar verificado (SPF+DKIM)
   * o los mails solo llegan a la casilla de la propia cuenta.
   */
  MAIL_FROM: z.string().min(1).default('AgendApp <onboarding@resend.dev>'),

  /**
   * Vida del link de reset de contraseña, en minutos. Mucho más corto que la
   * invitación: el link de reset toma una cuenta que ya está en uso.
   */
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),

  /**
   * Vida del link de verificación de email, en horas. Largo porque no da
   * acceso a nada: confirmar tarde no es un riesgo, es una molestia.
   */
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(48),

  // --- Pagos --------------------------------------------------------------
  /**
   * `sandbox` no cobra nada: cada checkout queda con un pago ya aprobado
   * esperando al webhook. Es el default para que el flujo de seña se pueda
   * probar en local sin cuenta de Mercado Pago. En producción va `mercadopago`.
   */
  PAYMENT_PROVIDER: z.enum(['sandbox', 'mercadopago']).default('sandbox'),

  /** Obligatorio con `PAYMENT_PROVIDER=mercadopago`. Un token de prueba empieza con `TEST-`. */
  MP_ACCESS_TOKEN: z.string().min(1).optional(),

  /**
   * El secreto con el que MP firma los avisos, del panel de webhooks.
   * Obligatorio con `PAYMENT_PROVIDER=mercadopago`: sin verificar la firma, el
   * webhook es un endpoint público donde cualquiera avisa "esto ya se pagó".
   */
  MP_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * La URL pública de **esta API**, la que el proveedor usa para avisar de un
   * pago. No es `APP_BASE_URL`, que es el frontend. En desarrollo, Mercado Pago
   * no puede alcanzar `localhost`: hace falta un túnel (ngrok o similar) y
   * poner acá la URL que devuelva.
   */
  API_PUBLIC_URL: z.string().url().default('http://localhost:3001'),
});

/**
 * Lo que un campo solo no puede validar: la API key es obligatoria únicamente
 * cuando el proveedor elegido la necesita. Falla al arrancar y no en el primer
 * envío, que es cuando enterarse ya es tarde.
 */
export const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (env.MAIL_PROVIDER === 'resend' && !env.RESEND_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['RESEND_API_KEY'],
      message: 'RESEND_API_KEY is required when MAIL_PROVIDER=resend',
    });
  }

  if (env.PAYMENT_PROVIDER === 'mercadopago') {
    if (!env.MP_ACCESS_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['MP_ACCESS_TOKEN'],
        message:
          'MP_ACCESS_TOKEN is required when PAYMENT_PROVIDER=mercadopago',
      });
    }

    if (!env.MP_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['MP_WEBHOOK_SECRET'],
        message:
          'MP_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=mercadopago',
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;
