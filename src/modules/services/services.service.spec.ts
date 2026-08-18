import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { ServicesService } from './services.service';

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const CATEGORY_ID = '22222222-2222-4222-8222-222222222222';
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333';
const BRANCH_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_BRANCH_ID = '55555555-5555-4555-8555-555555555555';
const RESOURCE_ID = '66666666-6666-4666-8666-666666666666';

const SERVICE_ROW = {
  id: SERVICE_ID,
  name: 'Corte de dama',
  description: null,
  durationMinutes: 45,
  priceCents: 1_000_000,
  depositAmountCents: 500_000,
  bufferAfterMinutes: 0,
  color: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  category: null,
};

describe('ServicesService', () => {
  let service: ServicesService;
  let prisma: {
    scoped: {
      $transaction: jest.Mock;
      service: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
      };
      serviceCategory: { findFirst: jest.Mock };
      employeeService: {
        findMany: jest.Mock;
        createMany: jest.Mock;
        deleteMany: jest.Mock;
      };
      employeeBranch: { findMany: jest.Mock };
      serviceResource: {
        findMany: jest.Mock;
        createMany: jest.Mock;
        deleteMany: jest.Mock;
      };
      resource: { findMany: jest.Mock };
    };
  };

  beforeEach(() => {
    prisma = {
      scoped: {
        $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
          callback(prisma.scoped),
        ),
        service: {
          findFirst: jest.fn().mockResolvedValue(SERVICE_ROW),
          findMany: jest.fn().mockResolvedValue([SERVICE_ROW]),
          create: jest.fn().mockResolvedValue(SERVICE_ROW),
          update: jest.fn().mockResolvedValue(SERVICE_ROW),
          delete: jest.fn().mockResolvedValue(SERVICE_ROW),
        },
        serviceCategory: {
          findFirst: jest.fn().mockResolvedValue({ id: CATEGORY_ID }),
        },
        employeeService: {
          findMany: jest.fn().mockResolvedValue([]),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        employeeBranch: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { employeeId: EMPLOYEE_ID, branchId: BRANCH_ID },
            ]),
        },
        serviceResource: {
          findMany: jest.fn().mockResolvedValue([]),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        resource: {
          findMany: jest.fn().mockResolvedValue([{ id: RESOURCE_ID }]),
        },
      },
    };

    service = new ServicesService(prisma as unknown as PrismaService);
  });

  const baseCreate = {
    name: 'Corte',
    durationMinutes: 30,
    priceCents: 1000,
  };

  describe('seña contra precio', () => {
    it('rechaza una seña mayor que el precio al crear', async () => {
      await expect(
        service.create({ ...baseCreate, depositAmountCents: 2000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('acepta una seña igual al precio', async () => {
      await expect(
        service.create({ ...baseCreate, depositAmountCents: 1000 }),
      ).resolves.toMatchObject({ id: SERVICE_ID });
    });

    /**
     * El PATCH manda un campo suelto pero la regla mira los dos valores
     * finales: el que no viene es el que ya estaba en la base.
     */
    it('rechaza bajar el precio por debajo de la seña guardada', async () => {
      await expect(
        service.update(SERVICE_ID, { priceCents: 100 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('acepta bajar el precio si el mismo PATCH saca la seña', async () => {
      await expect(
        service.update(SERVICE_ID, {
          priceCents: 100,
          depositAmountCents: null,
        }),
      ).resolves.toMatchObject({ id: SERVICE_ID });
    });
  });

  describe('categoría', () => {
    it('rechaza una categoría que no existe en el negocio', async () => {
      prisma.scoped.serviceCategory.findFirst.mockResolvedValue(null);

      await expect(
        service.create({ ...baseCreate, categoryId: CATEGORY_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no valida nada si el servicio nace sin categoría', async () => {
      await service.create(baseCreate);

      expect(prisma.scoped.serviceCategory.findFirst).not.toHaveBeenCalled();
    });

    it('dejar el servicio sin categoría no dispara la validación', async () => {
      await service.update(SERVICE_ID, { categoryId: null });

      expect(prisma.scoped.serviceCategory.findFirst).not.toHaveBeenCalled();
    });
  });

  it('un PATCH sin campos no toca la base', async () => {
    await expect(service.update(SERVICE_ID, {})).resolves.toMatchObject({
      id: SERVICE_ID,
    });

    expect(prisma.scoped.service.update).not.toHaveBeenCalled();
  });

  it('404 si el servicio no existe o es de otro negocio', async () => {
    prisma.scoped.service.findFirst.mockResolvedValue(null);

    await expect(service.findOne(SERVICE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('asignación de empleados', () => {
    const assignment = { employeeId: EMPLOYEE_ID, branchId: BRANCH_ID };

    it('guarda el set completo reemplazando el anterior', async () => {
      await service.setEmployees(SERVICE_ID, { assignments: [assignment] });

      expect(prisma.scoped.employeeService.deleteMany).toHaveBeenCalledWith({
        where: { serviceId: SERVICE_ID },
      });
      expect(prisma.scoped.employeeService.createMany).toHaveBeenCalled();
    });

    /**
     * La regla que sostiene la Fase 5: asignar a alguien donde no trabaja
     * generaría slots que nadie puede atender.
     */
    it('rechaza a un empleado que no trabaja en esa sucursal', async () => {
      await expect(
        service.setEmployees(SERVICE_ID, {
          assignments: [{ employeeId: EMPLOYEE_ID, branchId: OTHER_BRANCH_ID }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.scoped.employeeService.deleteMany).not.toHaveBeenCalled();
    });

    it('rechaza pares repetidos antes de tocar la base', async () => {
      await expect(
        service.setEmployees(SERVICE_ID, {
          assignments: [assignment, { ...assignment }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.scoped.employeeBranch.findMany).not.toHaveBeenCalled();
    });

    it('un array vacío borra las asignaciones sin insertar nada', async () => {
      await service.setEmployees(SERVICE_ID, { assignments: [] });

      expect(prisma.scoped.employeeService.deleteMany).toHaveBeenCalled();
      expect(prisma.scoped.employeeService.createMany).not.toHaveBeenCalled();
      // Sin pares que validar, ni se consulta employee_branches.
      expect(prisma.scoped.employeeBranch.findMany).not.toHaveBeenCalled();
    });

    it('arma el nombre del empleado con nombre y apellido', async () => {
      prisma.scoped.employeeService.findMany.mockResolvedValue([
        {
          employeeId: EMPLOYEE_ID,
          branchId: BRANCH_ID,
          employee: { user: { firstName: 'Lucía', lastName: 'Fernández' } },
          branch: { name: 'Sucursal Centro' },
        },
      ]);

      await expect(service.findEmployees(SERVICE_ID)).resolves.toEqual([
        {
          employeeId: EMPLOYEE_ID,
          employeeName: 'Lucía Fernández',
          branchId: BRANCH_ID,
          branchName: 'Sucursal Centro',
        },
      ]);
    });
  });

  describe('recursos que requiere el servicio', () => {
    it('guarda el set completo reemplazando el anterior', async () => {
      await service.setResources(SERVICE_ID, { resourceIds: [RESOURCE_ID] });

      expect(prisma.scoped.serviceResource.deleteMany).toHaveBeenCalledWith({
        where: { serviceId: SERVICE_ID },
      });
      expect(prisma.scoped.serviceResource.createMany).toHaveBeenCalled();
    });

    it('rechaza ids repetidos antes de tocar la base', async () => {
      await expect(
        service.setResources(SERVICE_ID, {
          resourceIds: [RESOURCE_ID, RESOURCE_ID],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.scoped.resource.findMany).not.toHaveBeenCalled();
    });

    it('rechaza un recurso que no existe en el negocio', async () => {
      prisma.scoped.resource.findMany.mockResolvedValue([]);

      await expect(
        service.setResources(SERVICE_ID, { resourceIds: [RESOURCE_ID] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.scoped.serviceResource.deleteMany).not.toHaveBeenCalled();
    });

    it('un array vacío borra los requisitos sin insertar nada', async () => {
      await service.setResources(SERVICE_ID, { resourceIds: [] });

      expect(prisma.scoped.serviceResource.deleteMany).toHaveBeenCalled();
      expect(prisma.scoped.serviceResource.createMany).not.toHaveBeenCalled();
      expect(prisma.scoped.resource.findMany).not.toHaveBeenCalled();
    });

    it('aplana la sucursal del recurso en la respuesta', async () => {
      prisma.scoped.serviceResource.findMany.mockResolvedValue([
        {
          resourceId: RESOURCE_ID,
          resource: {
            name: 'Camilla 1',
            branch: { id: BRANCH_ID, name: 'Sucursal Centro' },
          },
        },
      ]);

      await expect(service.findResources(SERVICE_ID)).resolves.toEqual([
        {
          resourceId: RESOURCE_ID,
          resourceName: 'Camilla 1',
          branchId: BRANCH_ID,
          branchName: 'Sucursal Centro',
        },
      ]);
    });
  });
});
