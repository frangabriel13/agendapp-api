import { randomUUID } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { Env } from '../../config/env.schema';
import {
  buildOpaqueToken,
  generateTokenSecret,
  parseOpaqueToken,
} from '../../common/utils/opaque-token.util';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Emisión, rotación y revocación de refresh tokens.
 *
 * El token NO es un JWT: es opaco, con formato `<id>.<secret>`.
 *   - `<id>`     → PK de la fila en `refresh_tokens`, para poder ubicarla.
 *   - `<secret>` → 32 bytes random; en la DB solo queda su hash argon2.
 *
 * Hace falta el `<id>` porque un hash con salt no se puede buscar por
 * igualdad: sin él habría que traer todas las filas y verificarlas una por una.
 *
 * Rotación: cada refresh revoca el token usado y emite uno nuevo dentro de la
 * misma familia (`familyId`). Si alguna vez llega un token YA revocado, es
 * señal de que alguien se lo copió, así que se revoca la familia entera y el
 * usuario tiene que volver a loguearse.
 *
 * Usa el cliente Prisma base: `RefreshToken` está exento del tenant-scope y
 * del soft-delete, y estas operaciones corren antes de que exista contexto.
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly ttlDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlDays = config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });
  }

  /** Emite un token nuevo. Sin `familyId` arranca una sesión nueva. */
  async issue(userId: string, familyId?: string): Promise<string> {
    const secret = generateTokenSecret();
    const tokenHash = await this.passwords.hash(secret);

    const row = await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId: familyId ?? randomUUID(),
        tokenHash,
        expiresAt: new Date(Date.now() + this.ttlDays * MS_PER_DAY),
      },
      select: { id: true },
    });

    return buildOpaqueToken(row.id, secret);
  }

  /**
   * Valida el token presentado y lo rota: revoca el viejo y emite uno nuevo
   * en la misma familia, todo en una transacción.
   *
   * Nota: es estricto a propósito. Si el frontend dispara dos refresh en
   * paralelo con el mismo token, el segundo cae en "reuso" y corta la sesión.
   * El cliente debe serializar sus refresh.
   */
  async rotate(presentedToken: string): Promise<{
    userId: string;
    refreshToken: string;
  }> {
    const stored = await this.findPresented(presentedToken);

    if (stored.revokedAt !== null) {
      // Reuso: el token ya se había rotado. Se asume robo.
      await this.revokeFamily(stored.familyId);
      this.logger.warn(
        { userId: stored.userId, familyId: stored.familyId },
        'Refresh token reutilizado: se revocó la familia completa',
      );
      throw new UnauthorizedException(
        'Sesión inválida, volvé a iniciar sesión',
      );
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException(
        'La sesión expiró, volvé a iniciar sesión',
      );
    }

    const secret = generateTokenSecret();
    const tokenHash = await this.passwords.hash(secret);

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });

      return tx.refreshToken.create({
        data: {
          userId: stored.userId,
          familyId: stored.familyId,
          tokenHash,
          expiresAt: new Date(Date.now() + this.ttlDays * MS_PER_DAY),
        },
        select: { id: true },
      });
    });

    return {
      userId: stored.userId,
      refreshToken: buildOpaqueToken(created.id, secret),
    };
  }

  /**
   * Cierra la sesión a la que pertenece el token presentado.
   * No falla si el token es inválido: un logout siempre "funciona".
   */
  async revokeSession(presentedToken: string): Promise<void> {
    try {
      const stored = await this.findPresented(presentedToken);
      await this.revokeFamily(stored.familyId);
    } catch {
      // Token inexistente, mal formado o adulterado: nada que cerrar.
    }
  }

  /** Revoca todos los tokens vivos de una familia (una sesión). */
  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Revoca todas las sesiones del usuario (ej. tras cambiar la contraseña).
   *
   * Acepta un cliente de transacción para que el reset de contraseña pueda
   * cambiar la clave y cerrar las sesiones en una sola unidad: si se hicieran
   * por separado y fallara la segunda, quedaría una contraseña nueva con las
   * sesiones viejas abiertas — justo lo que un reset viene a evitar.
   */
  async revokeAllForUser(
    userId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await client.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Parsea `<id>.<secret>`, busca la fila y verifica el secreto.
   * Devuelve la fila tal cual está (incluso revocada o vencida): las reglas
   * de negocio las aplica el caller, que es quien sabe qué hacer con cada caso.
   */
  private async findPresented(presentedToken: string): Promise<{
    id: string;
    userId: string;
    familyId: string;
    expiresAt: Date;
    revokedAt: Date | null;
  }> {
    const parsed = parseOpaqueToken(presentedToken);

    if (!parsed) {
      throw new UnauthorizedException('Refresh token inválido');
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { id: parsed.id },
      select: {
        id: true,
        userId: true,
        familyId: true,
        tokenHash: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    if (!stored) {
      throw new UnauthorizedException('Refresh token inválido');
    }

    const matches = await this.passwords.verify(
      stored.tokenHash,
      parsed.secret,
    );

    if (!matches) {
      throw new UnauthorizedException('Refresh token inválido');
    }

    return stored;
  }
}
