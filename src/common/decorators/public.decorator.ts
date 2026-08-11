import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marca un handler (o un controller entero) como accesible sin access token.
 *
 * El `JwtAuthGuard` es global desde la Fase 1.4: todo endpoint nace protegido y
 * hay que abrirlo explícitamente. Lo usan `/health`, los endpoints de auth
 * previos al login y —en la Fase 7— el portal público.
 *
 * Ojo: público NO significa "con tenant". En una ruta `@Public()` el contexto
 * queda sin resolver, así que `prisma.scoped` va a fallar. El portal público
 * resuelve su propio tenant por slug antes de tocar la base.
 */
export const Public = (): CustomDecorator<string> =>
  SetMetadata(IS_PUBLIC_KEY, true);
