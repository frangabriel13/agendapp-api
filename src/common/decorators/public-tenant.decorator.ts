import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Public } from './public.decorator';

export const PUBLIC_TENANT_KEY = 'publicTenant';

/**
 * Marca una ruta del **portal público**: sin access token, pero **con tenant**.
 *
 * Es `@Public()` más una cosa: `PublicTenantGuard` va a resolver el negocio por
 * el `:slug` de la URL y a montarlo en el contexto, así que `prisma.scoped`
 * funciona igual que en una ruta autenticada. Sin esto, una ruta `@Public()`
 * queda sin tenant y cualquier query scopeada revienta.
 *
 * Van juntas a propósito: separarlas dejaría abierta la combinación
 * "público y sin tenant" en un controller del portal, que es exactamente la que
 * expondría datos de todos los negocios.
 */
export const PublicTenant = (): MethodDecorator & ClassDecorator =>
  applyDecorators(Public(), SetMetadata(PUBLIC_TENANT_KEY, true));
