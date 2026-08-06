import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Env } from '../../../config/env.schema';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AuthenticatedUser, JwtPayload } from '../types/jwt-payload';

/**
 * Valida el access token y arma el `AuthenticatedUser` que queda en
 * `request.user`.
 *
 * Deliberadamente vuelve a la DB en cada request en lugar de confiar en el
 * contenido del token: así, si al empleado lo desactivan, le cambian el rol o
 * dan de baja el negocio, deja de tener acceso al instante y no cuando expire
 * el token. Es una query por request contra índices únicos.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_SECRET', { infer: true }),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const employee = await this.prisma.employee.findFirst({
      where: {
        id: payload.employeeId,
        userId: payload.sub,
        tenantId: payload.tenantId,
        isActive: true,
        deletedAt: null,
        user: { deletedAt: null },
        tenant: { deletedAt: null },
      },
      select: {
        id: true,
        tenantId: true,
        role: true,
        user: { select: { id: true, email: true } },
      },
    });

    if (!employee) {
      throw new UnauthorizedException('La sesión ya no es válida');
    }

    return {
      userId: employee.user.id,
      email: employee.user.email,
      tenantId: employee.tenantId,
      employeeId: employee.id,
      // El rol sale de la DB, no del token: no se puede quedar desactualizado.
      role: employee.role,
    };
  }
}
