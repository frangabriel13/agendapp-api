import {
  createParamDecorator,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../types/jwt-payload';

/**
 * Inyecta el usuario autenticado en el handler.
 * Solo tiene sentido en rutas protegidas por `JwtAuthGuard`.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    if (!request.user) {
      throw new UnauthorizedException('Falta el token de acceso');
    }

    return request.user;
  },
);
