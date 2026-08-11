import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { EmployeeRole } from '@prisma/client';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../modules/auth/types/jwt-payload';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Guard global de autorización por rol. Corre después del `JwtAuthGuard`, así
 * que `request.user` ya está resuelto.
 *
 * No hace nada si el handler no declara `@Roles(...)`: por defecto alcanza con
 * estar autenticado. Solo los endpoints que lo piden explícitamente restringen.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<EmployeeRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      // Un @Roles() sobre una ruta @Public() es un error de programación.
      throw new UnauthorizedException('Falta el token de acceso');
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException(
        'Tu rol no tiene permiso para realizar esta acción',
      );
    }

    return true;
  }
}
