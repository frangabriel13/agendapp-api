import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginationMeta, resolvePagination } from '../dto/pagination.dto';
import { TenantContextMissingError } from '../errors/tenant-context-missing.error';
import { TenantContextService } from '../tenant-context';
import { parseDateOnly } from '../utils/date-only.util';
import { MINUTES_PER_DAY, zonedWallTimeToUtc } from '../utils/timezone.util';
import {
  MAX_AUDIT_RANGE_DAYS,
  type AuditLogResponseDto,
  type ListAuditLogsQueryDto,
  type PaginatedAuditLogsDto,
} from './dto/audit-log.dto';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

const AUDIT_SELECT = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  changes: true,
  ipAddress: true,
  userAgent: true,
  createdAt: true,
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
} satisfies Prisma.AuditLogSelect;

type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_SELECT }>;

/**
 * Leer la auditoría.
 *
 * ⚠️ **`AuditLog` está en `TENANT_EXEMPT_MODELS`, así que acá no hay extension
 * que filtre.** El `tenantId` del `WHERE` lo pone este archivo, a mano, en
 * `scopeOf()`. Es la línea más peligrosa de todo el módulo: sin ella, cualquier
 * dueño vería el rastro completo de todos los negocios del sistema. Si tocás
 * este service, esa condición no se negocia — hay un e2e que lo fija.
 *
 * (El modelo está exento porque su `tenantId` es **nullable**: un login que no
 * entró no tiene negocio. La exención es correcta; lo que no puede faltar es
 * el filtro del lado de la lectura.)
 */
@Injectable()
export class AuditLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async findAll(query: ListAuditLogsQueryDto): Promise<PaginatedAuditLogsDto> {
    const where: Prisma.AuditLogWhereInput = {
      ...this.scopeOf(),
      ...(query.entityType === undefined
        ? {}
        : { entityType: query.entityType }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(await this.rangeFilter(query)),
    };

    const { page, pageSize, skip, take } = resolvePagination(query);

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        select: AUDIT_SELECT,
        // De lo más nuevo: un rastro se lee por arriba, como una bitácora.
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data: rows.map(toResponse),
      meta: paginationMeta(total, { page, pageSize }),
    };
  }

  /** El filtro que la extension no pone. Ver el aviso de arriba. */
  private scopeOf(): Prisma.AuditLogWhereInput {
    const tenantId = this.tenantContext.getTenantId();

    if (!tenantId) {
      throw new TenantContextMissingError('Tenant', 'read audit logs');
    }

    return { tenantId };
  }

  /**
   * El rango, en días del calendario del negocio.
   *
   * Mismo criterio que los reportes de pagos: quien pregunta "qué pasó el 2"
   * quiere el 2 de su ciudad, no el de UTC.
   */
  private async rangeFilter(
    query: ListAuditLogsQueryDto,
  ): Promise<Prisma.AuditLogWhereInput> {
    if (query.from === undefined && query.to === undefined) {
      return {};
    }

    if (query.from === undefined || query.to === undefined) {
      throw new BadRequestException(
        'El rango va con las dos puntas: `from` y `to`',
      );
    }

    const days =
      (parseDateOnly(query.to).getTime() -
        parseDateOnly(query.from).getTime()) /
      MS_PER_DAY;

    if (days < 0) {
      throw new BadRequestException('`from` no puede ser posterior a `to`');
    }

    if (days > MAX_AUDIT_RANGE_DAYS) {
      throw new BadRequestException(
        `El rango no puede pasar de ${MAX_AUDIT_RANGE_DAYS} días`,
      );
    }

    const timezone = await this.tenantTimezone();

    return {
      createdAt: {
        gte: zonedWallTimeToUtc(query.from, 0, timezone),
        lt: zonedWallTimeToUtc(query.to, MINUTES_PER_DAY, timezone),
      },
    };
  }

  private async tenantTimezone(): Promise<string> {
    const tenantId = this.tenantContext.getTenantId();

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId ?? undefined },
      select: { timezone: true },
    });

    return tenant?.timezone ?? 'America/Argentina/Buenos_Aires';
  }
}

function toResponse(row: AuditRow): AuditLogResponseDto {
  return {
    id: row.id,
    user:
      row.user === null
        ? null
        : {
            id: row.user.id,
            firstName: row.user.firstName,
            lastName: row.user.lastName,
            email: row.user.email,
          },
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    changes:
      row.changes === null || typeof row.changes !== 'object'
        ? null
        : (row.changes as Record<string, unknown>),
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
  };
}
