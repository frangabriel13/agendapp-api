import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Prisma, UserTokenPurpose } from '@prisma/client';
import {
  buildOpaqueToken,
  generateTokenSecret,
  parseOpaqueToken,
} from '../../common/utils/opaque-token.util';
import type { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * Un mensaje por propósito, y **el mismo para todos los fracasos** de ese
 * propósito: mal formado, inexistente, vencido, ya usado, revocado o de un
 * usuario dado de baja. Distinguirlos convertiría el endpoint en un oráculo
 * sobre qué cuentas existen y en qué estado están.
 */
const INVALID_TOKEN: Readonly<Record<UserTokenPurpose, string>> = {
  [UserTokenPurpose.PASSWORD_RESET]:
    'El link para restablecer la contraseña no es válido o ya venció',
  [UserTokenPurpose.EMAIL_VERIFICATION]:
    'El link de verificación no es válido o ya venció',
};

/** A qué pantalla del frontend apunta cada link. No son rutas de esta API. */
const FRONTEND_PATH: Readonly<Record<UserTokenPurpose, string>> = {
  [UserTokenPurpose.PASSWORD_RESET]: '/restablecer',
  [UserTokenPurpose.EMAIL_VERIFICATION]: '/verificar-email',
};

/**
 * Los tokens de un solo uso que viajan por mail: reset de contraseña y
 * verificación de email.
 *
 * Es el mismo esquema que la invitación de empleados y el refresh token —
 * opaco (`<id>.<secret>`), con solo el hash argon2 del secreto en la base — y
 * la razón de compartirlo es que las propiedades de seguridad ya están
 * pensadas: se puede revocar, no se puede leer de la base, y el `<id>` existe
 * para poder encontrar la fila sin traerlas todas.
 *
 * Usa el cliente Prisma **base**: los dos endpoints que lo canjean son públicos
 * y ahí no hay contexto de tenant. No se pierde nada, porque la fila se ubica
 * por el id del token.
 */
@Injectable()
export class UserTokenService {
  private readonly ttlMs: Readonly<Record<UserTokenPurpose, number>>;
  private readonly appBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = {
      [UserTokenPurpose.PASSWORD_RESET]:
        config.get('PASSWORD_RESET_TTL_MINUTES', { infer: true }) *
        MS_PER_MINUTE,
      [UserTokenPurpose.EMAIL_VERIFICATION]:
        config.get('EMAIL_VERIFICATION_TTL_HOURS', { infer: true }) *
        MS_PER_HOUR,
    };
    this.appBaseUrl = config.get('APP_BASE_URL', { infer: true });
  }

  /**
   * Emite un token nuevo y **revoca los anteriores** del mismo propósito.
   *
   * Que valga solo el último es lo que espera cualquiera que apretó dos veces
   * "olvidé mi contraseña": el link que sirve es el del mail más nuevo. Además
   * acota el daño de un mail viejo que quedó dando vueltas en una bandeja.
   *
   * El secreto se devuelve y no se guarda: en la base queda el hash. Por eso el
   * link se puede construir una sola vez, acá.
   */
  async issue(
    userId: string,
    purpose: UserTokenPurpose,
  ): Promise<{ url: string; expiresAt: Date }> {
    const secret = generateTokenSecret();
    const tokenHash = await this.passwords.hash(secret);
    const expiresAt = new Date(Date.now() + this.ttlMs[purpose]);

    const id = await this.prisma.$transaction(async (tx) => {
      await tx.userToken.updateMany({
        where: { userId, purpose, usedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const created = await tx.userToken.create({
        data: { userId, purpose, tokenHash, expiresAt },
        select: { id: true },
      });

      return created.id;
    });

    return {
      url: this.buildUrl(purpose, buildOpaqueToken(id, secret)),
      expiresAt,
    };
  }

  /**
   * Valida el token, lo marca como usado y aplica el efecto — todo en una sola
   * transacción, así no puede quedar un token quemado sin efecto ni un efecto
   * aplicado con el token todavía vivo.
   *
   * El `updateMany` con `usedAt: null` es lo que hace el uso único a prueba de
   * carreras: dos requests simultáneas con el mismo link se serializan en el
   * lock de la fila, y la segunda actualiza 0 filas y aborta. Un `findFirst`
   * seguido de un `update` dejaría pasar las dos.
   */
  async consume(
    presented: string,
    purpose: UserTokenPurpose,
    apply: (tx: Prisma.TransactionClient, userId: string) => Promise<void>,
  ): Promise<string> {
    const invalid = new BadRequestException(INVALID_TOKEN[purpose]);
    const parsed = parseOpaqueToken(presented);

    if (!parsed) {
      await this.passwords.burnTime();
      throw invalid;
    }

    const token = await this.prisma.userToken.findUnique({
      where: { id: parsed.id },
      select: {
        id: true,
        purpose: true,
        tokenHash: true,
        expiresAt: true,
        usedAt: true,
        revokedAt: true,
        user: { select: { id: true, deletedAt: true } },
      },
    });

    if (!token) {
      await this.passwords.burnTime();
      throw invalid;
    }

    const secretMatches = await this.passwords.verify(
      token.tokenHash,
      parsed.secret,
    );

    if (
      !secretMatches ||
      // Un token de verificación no puede servir como reset de contraseña, ni
      // al revés: el propósito es parte de lo que se valida, no una etiqueta.
      token.purpose !== purpose ||
      token.usedAt !== null ||
      token.revokedAt !== null ||
      token.expiresAt.getTime() <= Date.now() ||
      token.user.deletedAt !== null
    ) {
      throw invalid;
    }

    await this.prisma.$transaction(async (tx) => {
      const burned = await tx.userToken.updateMany({
        where: { id: token.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      if (burned.count !== 1) {
        throw invalid;
      }

      await apply(tx, token.user.id);
    });

    return token.user.id;
  }

  /** El link que abre la persona. Apunta al frontend, no a esta API. */
  private buildUrl(purpose: UserTokenPurpose, token: string): string {
    const base = this.appBaseUrl.replace(/\/+$/, '');

    return `${base}${FRONTEND_PATH[purpose]}?token=${encodeURIComponent(token)}`;
  }
}
