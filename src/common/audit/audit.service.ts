import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  tenantId: string | null;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes?: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Escribe la auditoría.
 *
 * **Nunca lanza.** Es la misma regla que `MailService` y por el mismo motivo:
 * si el INSERT falla, el error va al log y el request sigue su camino. Un
 * problema de auditoría no puede convertirse en un problema del usuario — que
 * no se pueda cancelar un turno porque la tabla de auditoría está llena sería
 * bastante peor que perder una fila.
 *
 * ⚠️ **Usa el cliente base, no `prisma.scoped`.** `AuditLog` está en
 * `TENANT_EXEMPT_MODELS` porque su `tenantId` es nullable: hay acciones sin
 * negocio (un login fallido). El `tenantId` se escribe explícito, desde el
 * contexto que le pasa el interceptor.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: entry.tenantId,
          userId: entry.userId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          changes:
            entry.changes === undefined
              ? Prisma.DbNull
              : (entry.changes as Prisma.InputJsonObject),
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
        },
        select: { id: true },
      });
    } catch (error) {
      this.logger.error(
        {
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          err: error instanceof Error ? error.message : String(error),
        },
        'No se pudo registrar la auditoría',
      );
    }
  }
}
