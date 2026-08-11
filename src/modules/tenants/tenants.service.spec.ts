import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CancellationRefundType, Prisma } from '@prisma/client';
import { TenantContextMissingError } from '../../common/errors/tenant-context-missing.error';
import type { TenantContextService } from '../../common/tenant-context';
import type { PrismaService } from '../../prisma/prisma.service';
import { TenantsService } from './tenants.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

const TENANT_ROW = {
  id: TENANT_ID,
  businessName: 'Peluquería Ana',
  slug: 'peluqueria-ana',
  timezone: 'America/Argentina/Buenos_Aires',
  currency: 'ARS',
  language: 'es',
};

const SETTINGS_ROW = {
  id: 'settings-1',
  cancellationPolicyHours: 24,
  cancellationRefundType: CancellationRefundType.FULL,
  cancellationRefundPercentage: null,
  requireDepositForBooking: false,
  defaultBufferMinutes: 0,
  updatedAt: new Date(),
};

const BRANDING_ROW = {
  id: 'branding-1',
  logoUrl: 'https://cdn.test/logo.png',
  primaryColor: '#7C3AED',
  displayName: 'Peluquería Ana',
  description: null,
  updatedAt: new Date(),
};

describe('TenantsService', () => {
  let service: TenantsService;
  let prisma: {
    scoped: {
      tenant: { findFirst: jest.Mock; update: jest.Mock };
      tenantBranding: { findFirst: jest.Mock; updateMany: jest.Mock };
      tenantSettings: { findFirst: jest.Mock; updateMany: jest.Mock };
    };
  };
  let tenantContext: { getTenantId: jest.Mock };

  beforeEach(() => {
    prisma = {
      scoped: {
        tenant: {
          findFirst: jest.fn().mockResolvedValue(TENANT_ROW),
          update: jest.fn().mockResolvedValue(TENANT_ROW),
        },
        tenantBranding: {
          findFirst: jest.fn().mockResolvedValue(BRANDING_ROW),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        tenantSettings: {
          findFirst: jest.fn().mockResolvedValue(SETTINGS_ROW),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      },
    };
    tenantContext = { getTenantId: jest.fn().mockReturnValue(TENANT_ID) };

    service = new TenantsService(
      prisma as unknown as PrismaService,
      tenantContext as unknown as TenantContextService,
    );
  });

  describe('findMine', () => {
    it('filtra el tenant por el id que hay en contexto', async () => {
      await expect(service.findMine()).resolves.toEqual(TENANT_ROW);
      expect(prisma.scoped.tenant.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TENANT_ID } }),
      );
    });

    it('devuelve 404 si el negocio no existe o está borrado', async () => {
      prisma.scoped.tenant.findFirst.mockResolvedValue(null);
      await expect(service.findMine()).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('falla fuerte si no hay tenant en contexto (bug de wiring)', async () => {
      tenantContext.getTenantId.mockReturnValue(null);
      await expect(service.findMine()).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
    });
  });

  describe('updateMine', () => {
    it('actualiza solo los campos enviados y excluye borrados', async () => {
      await service.updateMine({ businessName: 'Nuevo Nombre' });

      expect(prisma.scoped.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TENANT_ID, deletedAt: null },
          data: { businessName: 'Nuevo Nombre' },
        }),
      );
    });

    it('con body vacío no toca la base', async () => {
      await service.updateMine({});

      expect(prisma.scoped.tenant.update).not.toHaveBeenCalled();
      expect(prisma.scoped.tenant.findFirst).toHaveBeenCalledTimes(1);
    });

    it('traduce el P2025 de Prisma a un 404', async () => {
      prisma.scoped.tenant.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('not found', {
          code: 'P2025',
          clientVersion: '7.8.0',
        }),
      );

      await expect(
        service.updateMine({ timezone: 'UTC' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateBranding', () => {
    it('no manda where: el scope lo pone la extension de Prisma', async () => {
      await service.updateBranding({ displayName: 'Ana Hair' });

      expect(prisma.scoped.tenantBranding.updateMany).toHaveBeenCalledWith({
        data: { displayName: 'Ana Hair' },
      });
    });

    it('distingue null (borrar) de ausente (no tocar)', async () => {
      await service.updateBranding({ logoUrl: null });

      expect(prisma.scoped.tenantBranding.updateMany).toHaveBeenCalledWith({
        data: { logoUrl: null },
      });
    });

    it('devuelve 404 si el branding no existe', async () => {
      prisma.scoped.tenantBranding.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.updateBranding({ displayName: 'Ana Hair' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateSettings', () => {
    it('exige porcentaje cuando el reembolso pasa a parcial', async () => {
      await expect(
        service.updateSettings({
          cancellationRefundType: CancellationRefundType.PARTIAL,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.scoped.tenantSettings.updateMany).not.toHaveBeenCalled();
    });

    it('acepta el parcial si viene el porcentaje en el mismo PATCH', async () => {
      await service.updateSettings({
        cancellationRefundType: CancellationRefundType.PARTIAL,
        cancellationRefundPercentage: 50,
      });

      expect(prisma.scoped.tenantSettings.updateMany).toHaveBeenCalledWith({
        data: {
          cancellationRefundType: CancellationRefundType.PARTIAL,
          cancellationRefundPercentage: 50,
        },
      });
    });

    it('limpia el porcentaje cuando el reembolso deja de ser parcial', async () => {
      prisma.scoped.tenantSettings.findFirst.mockResolvedValue({
        ...SETTINGS_ROW,
        cancellationRefundType: CancellationRefundType.PARTIAL,
        cancellationRefundPercentage: 50,
      });

      await service.updateSettings({
        cancellationRefundType: CancellationRefundType.NONE,
      });

      expect(prisma.scoped.tenantSettings.updateMany).toHaveBeenCalledWith({
        data: {
          cancellationRefundType: CancellationRefundType.NONE,
          cancellationRefundPercentage: null,
        },
      });
    });

    it('no recalcula el porcentaje si el PATCH no toca la política', async () => {
      prisma.scoped.tenantSettings.findFirst.mockResolvedValue({
        ...SETTINGS_ROW,
        cancellationRefundType: CancellationRefundType.PARTIAL,
        cancellationRefundPercentage: 30,
      });

      await service.updateSettings({ defaultBufferMinutes: 15 });

      expect(prisma.scoped.tenantSettings.updateMany).toHaveBeenCalledWith({
        data: { defaultBufferMinutes: 15 },
      });
    });
  });
});
