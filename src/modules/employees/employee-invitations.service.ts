import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import {
  buildOpaqueToken,
  generateTokenSecret,
  parseOpaqueToken,
} from '../../common/utils/opaque-token.util';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import type { ActivateEmployeeDto } from './dto/employee.dto';

const MS_PER_HOUR = 60 * 60 * 1000;

/** Un solo mensaje para todos los fracasos: ver abajo por qué. */
const INVALID_INVITATION = 'El link de invitación no es válido o ya venció';

/**
 * Invitaciones de empleados: cómo se fabrica y cómo se canjea el link de
 * activación.
 *
 * El token es opaco (`<id>.<secret>`), igual que el refresh token: en la base
 * queda solo el hash argon2 del secreto, así que **el link se puede mostrar una
 * sola vez**. Perderlo no es grave: se reenvía la invitación, que emite una
 * nueva y revoca la anterior.
 *
 * Mientras no exista el envío de mails (diferido a antes de la Fase 7), el link
 * se devuelve en la respuesta de `POST /employees` y el dueño se lo hace llegar
 * al empleado por donde quiera. Cuando haya proveedor de mail, el email pasa a
 * ser un canal más y **este flujo no cambia**.
 *
 * Usa el cliente Prisma base, igual que `AuthService`: la activación es un
 * endpoint público, o sea sin contexto de tenant. Acá no se pierde nada, porque
 * la fila se ubica por el id del token y no hay nada que filtrar por negocio.
 */
@Injectable()
export class EmployeeInvitationService {
  private readonly logger = new Logger(EmployeeInvitationService.name);
  private readonly ttlHours: number;
  private readonly appBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlHours = config.get('EMPLOYEE_INVITATION_TTL_HOURS', {
      infer: true,
    });
    this.appBaseUrl = config.get('APP_BASE_URL', { infer: true });
  }

  /**
   * Fabrica un secreto nuevo y su hash. El secreto vive solo en memoria: lo
   * escribe el caller en la respuesta y nunca toca la base sin hashear.
   */
  async mint(): Promise<{
    secret: string;
    tokenHash: string;
    expiresAt: Date;
  }> {
    const secret = generateTokenSecret();

    return {
      secret,
      tokenHash: await this.passwords.hash(secret),
      expiresAt: new Date(Date.now() + this.ttlHours * MS_PER_HOUR),
    };
  }

  /** El link que abre el empleado. Apunta al frontend, no a esta API. */
  buildActivationUrl(invitationId: string, secret: string): string {
    const token = buildOpaqueToken(invitationId, secret);

    return `${this.appBaseUrl.replace(/\/+$/, '')}/activar?token=${encodeURIComponent(token)}`;
  }

  /**
   * Canjea la invitación: le pone la contraseña al usuario y marca el token
   * como usado, en una sola transacción.
   *
   * Todos los fracasos (token mal formado, inexistente, vencido, ya usado,
   * empleado dado de baja) devuelven el MISMO mensaje. Distinguirlos le diría a
   * cualquiera con un link viejo si esa cuenta existe y en qué estado está.
   */
  async accept(dto: ActivateEmployeeDto): Promise<void> {
    const parsed = parseOpaqueToken(dto.token);

    if (!parsed) {
      await this.passwords.burnTime();
      throw new BadRequestException(INVALID_INVITATION);
    }

    const invitation = await this.prisma.employeeInvitation.findUnique({
      where: { id: parsed.id },
      select: {
        id: true,
        tokenHash: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        employee: {
          select: {
            id: true,
            isActive: true,
            deletedAt: true,
            userId: true,
            user: { select: { passwordHash: true, deletedAt: true } },
            tenant: { select: { deletedAt: true } },
          },
        },
      },
    });

    if (!invitation) {
      await this.passwords.burnTime();
      throw new BadRequestException(INVALID_INVITATION);
    }

    const secretMatches = await this.passwords.verify(
      invitation.tokenHash,
      parsed.secret,
    );

    const { employee } = invitation;

    if (
      !secretMatches ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt.getTime() <= Date.now() ||
      employee.deletedAt !== null ||
      !employee.isActive ||
      employee.user.deletedAt !== null ||
      employee.tenant.deletedAt !== null ||
      // Ya tiene contraseña: la invitación quedó vieja. Dejarla pasar sería
      // regalar un cambio de contraseña sin conocer la actual.
      employee.user.passwordHash !== null
    ) {
      throw new BadRequestException(INVALID_INVITATION);
    }

    const passwordHash = await this.passwords.hash(dto.password);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: employee.userId },
        data: { passwordHash },
      });

      await tx.employeeInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });
    });

    this.logger.log(
      { employeeId: employee.id },
      'Invitación aceptada: el empleado ya puede iniciar sesión',
    );
  }
}
