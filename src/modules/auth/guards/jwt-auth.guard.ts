import { Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { TenantContextService } from '../../../common/tenant-context';
import type { AuthenticatedUser } from '../types/jwt-payload';

/**
 * Guard GLOBAL (registrado con `APP_GUARD` en `AppModule`): todo endpoint exige
 * un access token válido salvo que esté marcado con `@Public()`.
 *
 * Además de autenticar, es el punto donde se resuelve el tenant: apenas la
 * estrategia valida el token, empuja `tenantId`/`userId`/`employeeId`/`role` al
 * store que montó `TenantContextMiddleware`. A partir de ahí `prisma.scoped`
 * filtra solo, sin que ningún service tenga que acordarse del `tenantId`.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // En una ruta pública no se resuelve tenant: el store queda sin resolver y
    // `prisma.scoped` falla si alguien lo usa sin declarar su contexto.
    if (this.isPublic(context)) {
      return true;
    }

    // Lanza 401 por su cuenta si el token falta, venció o el empleado ya no
    // está activo (ver `JwtStrategy.validate`).
    const activated = (await super.canActivate(context)) as boolean;

    if (!activated) {
      return false;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;

    if (user) {
      this.tenantContext.set({
        tenantId: user.tenantId,
        userId: user.userId,
        employeeId: user.employeeId,
        role: user.role,
      });
    }

    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false
    );
  }
}
