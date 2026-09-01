import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLIC_TENANT_KEY } from '../decorators/public-tenant.decorator';
import { TenantContextService } from '../tenant-context';

/**
 * Resuelve el negocio del portal público a partir del `:slug` de la URL.
 *
 * **Guard y no middleware**, aunque el plan original decía middleware: es lo
 * mismo que hace `JwtAuthGuard`, que también monta el tenant con
 * `tenantContext.set(...)` corriendo adentro del ALS de
 * `TenantContextMiddleware`. Un guard además tiene los route params ya
 * resueltos en el `ExecutionContext`; un middleware de Express tendría que
 * volver a parsear la URL para sacar el slug.
 *
 * ⚠️ **Va registrado ANTES que `ActiveSubscriptionGuard`** en `AppModule`. Los
 * guards globales corren en orden de registro, y el de suscripción deja pasar
 * cuando no encuentra tenant: si corriera primero, `@RequiresActiveSubscription()`
 * en una ruta del portal no cortaría nada y el bug sería mudo.
 *
 * No hace nada salvo que la ruta declare `@PublicTenant()`.
 */
@Injectable()
export class PublicTenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublicTenant = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_TENANT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!isPublicTenant) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const slug = request.params?.slug;

    if (typeof slug !== 'string' || slug.length === 0) {
      throw new NotFoundException('No encontramos ese negocio');
    }

    // Cliente base y no `scoped`: todavía no hay tenant que aplicar, y es
    // justamente lo que estamos resolviendo. Por lo mismo el `deletedAt` va a
    // mano — la extension de soft delete solo corre en `scoped`.
    const tenant = await this.tenantContext.runWithoutTenant(async () =>
      this.prisma.tenant.findFirst({
        where: { slug: slug.toLowerCase(), deletedAt: null },
        select: { id: true },
      }),
    );

    if (!tenant) {
      // Mismo 404 para "no existe" y "está borrado": distinguirlos le diría a
      // cualquiera qué slugs estuvieron tomados alguna vez.
      throw new NotFoundException('No encontramos ese negocio');
    }

    // Sin `userId`: hay negocio, no hay persona. Es el mismo caso del webhook
    // de pagos, y por eso `TenantContext.userId` es opcional.
    this.tenantContext.set({ tenantId: tenant.id });

    return true;
  }
}
