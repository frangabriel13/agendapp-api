import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CancellationRefundType, Prisma } from '@prisma/client';
import { TenantContextMissingError } from '../../common/errors/tenant-context-missing.error';
import { TenantContextService } from '../../common/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  TenantBrandingResponseDto,
  UpdateTenantBrandingDto,
} from './dto/tenant-branding.dto';
import type { TenantResponseDto } from './dto/tenant-response.dto';
import type {
  TenantSettingsResponseDto,
  UpdateTenantSettingsDto,
} from './dto/tenant-settings.dto';
import type { UpdateTenantDto } from './dto/update-tenant.dto';

const TENANT_SELECT = {
  id: true,
  businessName: true,
  slug: true,
  timezone: true,
  currency: true,
  language: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  createdAt: true,
  updatedAt: true,
  plan: {
    select: {
      id: true,
      name: true,
      slug: true,
      maxEmployees: true,
      maxBranches: true,
      includesClinicRecords: true,
      includesResources: true,
      supportLevel: true,
    },
  },
} satisfies Prisma.TenantSelect;

const BRANDING_SELECT = {
  id: true,
  logoUrl: true,
  primaryColor: true,
  displayName: true,
  description: true,
  updatedAt: true,
} satisfies Prisma.TenantBrandingSelect;

const SETTINGS_SELECT = {
  id: true,
  cancellationPolicyHours: true,
  cancellationRefundType: true,
  cancellationRefundPercentage: true,
  requireDepositForBooking: true,
  defaultBufferMinutes: true,
  publicBookingEnabled: true,
  minBookingNoticeMinutes: true,
  maxBookingDaysAhead: true,
  updatedAt: true,
} satisfies Prisma.TenantSettingsSelect;

/**
 * El negocio del usuario logueado y sus dos hijos 1:1 (branding y settings).
 *
 * Las tres filas se crean juntas en el registro (`AuthService.register`), así
 * que acá no hay altas: solo lectura y edición. Si alguna falta, es data
 * corrupta y responde 404 en vez de crearla por las suyas.
 *
 * Sobre qué cliente Prisma usa cada cosa:
 * - `TenantBranding` / `TenantSettings` llevan `tenantId`, así que van por
 *   `prisma.scoped` y la extension pone el filtro sola. Por eso los updates
 *   usan `updateMany` sin `where`: es la forma de no repetir el `tenantId` a
 *   mano (ver antipatrón #1 del roadmap).
 * - `Tenant` está en `TENANT_EXEMPT_MODELS` (él ES el tenant, no tiene columna
 *   `tenantId`), así que ahí sí hay que filtrar por `id` explícitamente.
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async findMine(): Promise<TenantResponseDto> {
    const tenantId = this.requireTenantId('findMine');

    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { id: tenantId },
      select: TENANT_SELECT,
    });

    if (!tenant) {
      throw new NotFoundException('El negocio no existe o fue dado de baja');
    }

    return tenant;
  }

  async updateMine(dto: UpdateTenantDto): Promise<TenantResponseDto> {
    const tenantId = this.requireTenantId('updateMine');
    const data = pickDefined<Prisma.TenantUpdateInput>({
      businessName: dto.businessName,
      timezone: dto.timezone,
      currency: dto.currency,
      language: dto.language,
    });

    if (isEmpty(data)) {
      return this.findMine();
    }

    try {
      return await this.prisma.scoped.tenant.update({
        where: { id: tenantId, deletedAt: null },
        data,
        select: TENANT_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('El negocio no existe o fue dado de baja');
      }
      throw error;
    }
  }

  async findBranding(): Promise<TenantBrandingResponseDto> {
    const branding = await this.prisma.scoped.tenantBranding.findFirst({
      select: BRANDING_SELECT,
    });

    if (!branding) {
      throw new NotFoundException('El negocio no tiene branding configurado');
    }

    return branding;
  }

  async updateBranding(
    dto: UpdateTenantBrandingDto,
  ): Promise<TenantBrandingResponseDto> {
    const data = pickDefined<Prisma.TenantBrandingUpdateInput>({
      logoUrl: dto.logoUrl,
      primaryColor: dto.primaryColor,
      displayName: dto.displayName,
      description: dto.description,
    });

    if (isEmpty(data)) {
      return this.findBranding();
    }

    // Sin `where`: la extension de tenant-scope lo completa con el tenantId.
    const { count } = await this.prisma.scoped.tenantBranding.updateMany({
      data,
    });

    if (count === 0) {
      throw new NotFoundException('El negocio no tiene branding configurado');
    }

    return this.findBranding();
  }

  async findSettings(): Promise<TenantSettingsResponseDto> {
    const settings = await this.prisma.scoped.tenantSettings.findFirst({
      select: SETTINGS_SELECT,
    });

    if (!settings) {
      throw new NotFoundException('El negocio no tiene configuración cargada');
    }

    return settings;
  }

  async updateSettings(
    dto: UpdateTenantSettingsDto,
  ): Promise<TenantSettingsResponseDto> {
    const current = await this.findSettings();
    const data = pickDefined<Prisma.TenantSettingsUpdateInput>({
      cancellationPolicyHours: dto.cancellationPolicyHours,
      cancellationRefundType: dto.cancellationRefundType,
      requireDepositForBooking: dto.requireDepositForBooking,
      defaultBufferMinutes: dto.defaultBufferMinutes,
      publicBookingEnabled: dto.publicBookingEnabled,
      minBookingNoticeMinutes: dto.minBookingNoticeMinutes,
      maxBookingDaysAhead: dto.maxBookingDaysAhead,
    });

    // El porcentaje se recalcula solo si el PATCH tocó la política de reembolso.
    if (
      dto.cancellationRefundType !== undefined ||
      dto.cancellationRefundPercentage !== undefined
    ) {
      data.cancellationRefundPercentage = this.resolveRefundPercentage(
        current,
        dto,
      );
    }

    if (isEmpty(data)) {
      return current;
    }

    const { count } = await this.prisma.scoped.tenantSettings.updateMany({
      data,
    });

    if (count === 0) {
      throw new NotFoundException('El negocio no tiene configuración cargada');
    }

    return this.findSettings();
  }

  /**
   * El porcentaje solo tiene sentido con reembolso parcial: con cualquier otro
   * tipo se limpia, y con `PARTIAL` es obligatorio (si no venía uno cargado de
   * antes, hay que mandarlo en el mismo PATCH). La base repite la regla con
   * CHECK constraints — esto es para devolver un 400 con mensaje claro en vez
   * de un 500 de Postgres.
   */
  private resolveRefundPercentage(
    current: TenantSettingsResponseDto,
    dto: UpdateTenantSettingsDto,
  ): number | null {
    const refundType =
      dto.cancellationRefundType ?? current.cancellationRefundType;
    const percentage =
      dto.cancellationRefundPercentage ?? current.cancellationRefundPercentage;

    if (refundType !== CancellationRefundType.PARTIAL) {
      return null;
    }

    if (percentage === null) {
      throw new BadRequestException(
        'Con reembolso parcial hay que indicar cancellationRefundPercentage (0 a 100)',
      );
    }

    return percentage;
  }

  /**
   * `Tenant` no lo scopea la extension, así que el id sale del contexto a mano.
   * Que falte es un bug de wiring (falta el guard o el middleware), no un error
   * del cliente: por eso el mismo error que usa la extension → 500.
   */
  private requireTenantId(operation: string): string {
    const tenantId = this.tenantContext.getTenantId();

    if (!tenantId) {
      throw new TenantContextMissingError('Tenant', operation);
    }

    return tenantId;
  }
}

/** Deja solo las claves que el PATCH mandó (`undefined` = "no tocar"). */
function pickDefined<T extends object>(values: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as T;
}

function isEmpty(data: object): boolean {
  return Object.keys(data).length === 0;
}
