import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContextMissingError } from '../../common/errors/tenant-context-missing.error';
import type { TenantContextService } from '../../common/tenant-context';
import type { PrismaService } from '../../prisma/prisma.service';
import { ResourcesService } from './resources.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const RESOURCE_ID = '22222222-2222-4222-8222-222222222222';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';

const RESOURCE_ROW = {
  id: RESOURCE_ID,
  name: 'Camilla 1',
  description: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  branch: { id: BRANCH_ID, name: 'Sucursal Centro' },
};

describe('ResourcesService', () => {
  let service: ResourcesService;
  let prisma: {
    scoped: {
      tenant: { findFirst: jest.Mock };
      branch: { findFirst: jest.Mock };
      resource: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
      };
    };
  };
  let tenantContext: { getTenantId: jest.Mock };

  /** El plan que devuelve el tenant mockeado. */
  function planWith(includesResources: boolean, name = 'Pro'): void {
    prisma.scoped.tenant.findFirst.mockResolvedValue({
      plan: { name, includesResources },
    });
  }

  beforeEach(() => {
    prisma = {
      scoped: {
        tenant: { findFirst: jest.fn() },
        branch: { findFirst: jest.fn().mockResolvedValue({ id: BRANCH_ID }) },
        resource: {
          findFirst: jest.fn().mockResolvedValue(RESOURCE_ROW),
          findMany: jest.fn().mockResolvedValue([RESOURCE_ROW]),
          create: jest.fn().mockResolvedValue(RESOURCE_ROW),
          update: jest.fn().mockResolvedValue(RESOURCE_ROW),
          delete: jest.fn().mockResolvedValue(RESOURCE_ROW),
        },
      },
    };
    tenantContext = { getTenantId: jest.fn().mockReturnValue(TENANT_ID) };
    planWith(true);

    service = new ResourcesService(
      prisma as unknown as PrismaService,
      tenantContext as unknown as TenantContextService,
    );
  });

  const baseCreate = { name: 'Camilla 1', branchId: BRANCH_ID };

  describe('feature de plan', () => {
    it('deja crear si el plan incluye recursos', async () => {
      await expect(service.create(baseCreate)).resolves.toMatchObject({
        id: RESOURCE_ID,
      });
    });

    it('403 si el plan no los incluye, y no llega a insertar', async () => {
      planWith(false, 'Básico');

      await expect(service.create(baseCreate)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.scoped.resource.create).not.toHaveBeenCalled();
    });

    /** El gate es solo del alta: un plan degradado no esconde lo ya cargado. */
    it('no bloquea leer ni editar lo que ya existe', async () => {
      planWith(false, 'Básico');

      await expect(service.findOne(RESOURCE_ID)).resolves.toMatchObject({
        id: RESOURCE_ID,
      });
      await expect(
        service.update(RESOURCE_ID, { isActive: false }),
      ).resolves.toMatchObject({ id: RESOURCE_ID });
    });

    it('falta de contexto de tenant es error de wiring, no del cliente', async () => {
      tenantContext.getTenantId.mockReturnValue(undefined);

      await expect(service.create(baseCreate)).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
    });
  });

  it('rechaza una sucursal que no existe en el negocio', async () => {
    prisma.scoped.branch.findFirst.mockResolvedValue(null);

    await expect(service.create(baseCreate)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.scoped.resource.create).not.toHaveBeenCalled();
  });

  it('traduce el UNIQUE de nombre por sucursal a un 409', async () => {
    prisma.scoped.resource.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.0.0',
      }),
    );

    await expect(service.create(baseCreate)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('404 si el recurso no existe o es de otro negocio', async () => {
    prisma.scoped.resource.findFirst.mockResolvedValue(null);

    await expect(service.findOne(RESOURCE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('un PATCH sin campos no toca la base', async () => {
    await expect(service.update(RESOURCE_ID, {})).resolves.toMatchObject({
      id: RESOURCE_ID,
    });

    expect(prisma.scoped.resource.update).not.toHaveBeenCalled();
  });

  it('ordena por sucursal y después por nombre', async () => {
    await service.findAll({});

    expect(prisma.scoped.resource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ branch: { name: 'asc' } }, { name: 'asc' }],
      }),
    );
  });
});
